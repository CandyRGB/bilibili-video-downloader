/*!
 * fmp4-mux.js — 把 B 站 DASH 的两条独立 fMP4（video / audio）合并成一个可播放文件
 *
 * 设计要点
 *  - 只做分片级（moof/mdat）搬运，不解码、不重编码，速度接近文件拷贝
 *  - 全程流式，内存占用与文件大小无关
 *  - 重建 moov：保留视频 trak、追加音频 trak，重写 mvex/trex，统一 track_ID
 *  - 丢弃 sidx（分片字节偏移已失效）；播放器按 moof 顺序解析即可
 *  - 按 tfdt（解码时间戳）交错输出，保证音画同步与顺滑 seek
 *
 * 兼容：Chrome / Edge / Firefox / Node 18+
 */
(function (global) {
  'use strict';

  var EMPTY = new Uint8Array(0);

  /* ---------------------------------------------------------------- 基础读写 */

  function type4(u8, p) {
    return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  }

  function u32(u8, p) {
    return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
  }

  function w32(u8, p, v) {
    u8[p] = (v >>> 24) & 0xff;
    u8[p + 1] = (v >>> 16) & 0xff;
    u8[p + 2] = (v >>> 8) & 0xff;
    u8[p + 3] = v & 0xff;
  }

  function u64(u8, p) {
    return u32(u8, p) * 0x100000000 + u32(u8, p + 4);
  }

  /** 解析 [start,end) 区间的同级盒子 */
  function boxes(u8, start, end) {
    var list = [];
    var p = start;
    while (p + 8 <= end) {
      var size = u32(u8, p);
      var type = type4(u8, p + 4);
      var hs = 8;
      if (size === 1) {
        size = u64(u8, p + 8);
        hs = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hs || p + size > end) break;
      list.push({ type: type, start: p, size: size, body: p + hs, end: p + size });
      p += size;
    }
    return list;
  }

  function findBox(u8, start, end, type) {
    var list = boxes(u8, start, end);
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }

  /** 递归遍历容器盒子，对每个命中的盒子调用 cb(type, body, end) */
  var CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, mvex: 1, moof: 1, traf: 1, edts: 1, dinf: 1 };

  function walk(u8, start, end, cb, depth) {
    depth = depth || 0;
    if (depth > 6) return;
    var list = boxes(u8, start, end);
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      cb(b.type, b.body, b.end);
      if (CONTAINERS[b.type]) walk(u8, b.body, b.end, cb, depth + 1);
    }
  }

  /** 用 4 字节长度 + 类型 拼一个盒子 */
  function box(type, parts) {
    var len = 8;
    for (var i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len);
    w32(out, 0, len);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    var o = 8;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], o);
      o += parts[j].length;
    }
    return out;
  }

  /* ------------------------------------------------------------ 流式字节源 */

  /**
   * @param {Function} read  返回 Promise<Uint8Array|null>，null 表示 EOF
   */
  function ByteSource(read, initial) {
    this._read = read;
    this._queue = initial && initial.length ? [initial] : [];
    this._len = initial && initial.length ? initial.length : 0;
    this._eof = false;
    this.position = 0;
  }

  ByteSource.prototype._fill = function () {
    var self = this;
    if (this._eof) return Promise.resolve(false);
    return this._read().then(function (chunk) {
      if (!chunk || !chunk.length) {
        self._eof = true;
        return false;
      }
      self._queue.push(chunk);
      self._len += chunk.length;
      return true;
    });
  };

  /** 保证队首至少有 n 字节连续内存（不足则把前几个 chunk 拼起来） */
  ByteSource.prototype._head = function (n) {
    var q = this._queue;
    if (!q.length) return EMPTY;
    if (q[0].length >= n || q.length === 1) return q[0];
    var need = 0;
    var i = 0;
    while (i < q.length && need < n) {
      need += q[i].length;
      i++;
    }
    var out = new Uint8Array(need);
    var off = 0;
    for (var k = 0; k < i; k++) {
      out.set(q[k], off);
      off += q[k].length;
    }
    this._queue = [out].concat(q.slice(i));
    return out;
  };

  ByteSource.prototype._consume = function (n) {
    var left = n;
    while (left > 0) {
      var c = this._queue[0];
      if (left >= c.length) {
        this._queue.shift();
        left -= c.length;
      } else {
        this._queue[0] = c.subarray(left);
        left = 0;
      }
    }
    this._len -= n;
    this.position += n;
  };

  /** 保证队首有 n 字节；EOF 时返回 null */
  ByteSource.prototype.need = async function (n) {
    while (this._len < n && !this._eof) await this._fill();
    if (this._len < n) return null;
    return this._head(n);
  };

  /** 取出恰好 n 字节（拷贝） */
  ByteSource.prototype.take = async function (n) {
    var head = await this.need(n);
    if (!head) throw new Error('意外的文件结尾：期望 ' + n + ' 字节');
    var out = head.slice(0, n);
    this._consume(n);
    return out;
  };

  /** 丢弃 n 字节 */
  ByteSource.prototype.skip = async function (n) {
    var left = n;
    while (left > 0) {
      if (this._len === 0) {
        if (!(await this._fill())) throw new Error('意外的文件结尾：跳过 ' + n + ' 字节失败');
        continue;
      }
      var c = this._queue[0];
      var take = Math.min(c.length, left);
      if (take === c.length) this._queue.shift();
      else this._queue[0] = c.subarray(take);
      this._len -= take;
      this.position += take;
      left -= take;
    }
  };

  /** 把 n 字节原样搬运到 sink（不整体入内存） */
  ByteSource.prototype.copyTo = async function (sink, n) {
    var left = n;
    while (left > 0) {
      if (this._len === 0) {
        if (!(await this._fill())) throw new Error('意外的文件结尾：还差 ' + left + ' 字节');
        continue;
      }
      var c = this._queue[0];
      var take = Math.min(c.length, left);
      var view = take === c.length ? c : c.subarray(0, take);
      if (take === c.length) this._queue.shift();
      else this._queue[0] = c.subarray(take);
      this._len -= take;
      this.position += take;
      left -= take;
      await sink.write(view);
    }
  };

  /* --------------------------------------------------------------- 初始化段 */

  /** 一路读到 moov，返回 { ftyp, moov }（均已拷贝） */
  async function readInit(src) {
    var ftyp = null;
    for (;;) {
      var head = await src.need(8);
      if (!head) throw new Error('文件结构异常：未找到 moov');
      var size = u32(head, 0);
      var type = type4(head, 4);
      if (size === 1) {
        var big = await src.need(16);
        if (!big) throw new Error('文件结构异常：' + type);
        size = u64(big, 8);
      } else if (size === 0) {
        throw new Error('文件结构异常：' + type + ' 长度为 0');
      }
      if (size < 8) throw new Error('文件结构异常：' + type + ' 长度非法');

      if (type === 'moov') return { ftyp: ftyp, moov: await src.take(size) };
      if (type === 'ftyp') {
        ftyp = await src.take(size);
        continue;
      }
      await src.skip(size);
    }
  }

  /** 从 moov 中抽出需要保留/重写的盒子 */
  function parseInit(moov) {
    var top = boxes(moov, 8, moov.length);
    var pick = function (t) {
      for (var i = 0; i < top.length; i++) if (top[i].type === t) return top[i];
      return null;
    };
    var mvhd = pick('mvhd');
    var trak = pick('trak');
    var mvex = pick('mvex');
    if (!mvhd || !trak) throw new Error('moov 缺少 mvhd/trak');

    var trex = null;
    if (mvex) {
      var kids = boxes(moov, mvex.body, mvex.end);
      for (var i = 0; i < kids.length; i++) if (kids[i].type === 'trex') trex = kids[i];
    }

    var mdia = findBox(moov, trak.body, trak.end, 'mdia');
    var mdhd = mdia ? findBox(moov, mdia.body, mdia.end, 'mdhd') : null;
    var timescale = 0;
    if (mdhd) {
      var ver = moov[mdhd.body];
      timescale = u32(moov, mdhd.body + (ver === 1 ? 20 : 12));
    }
    if (!timescale) timescale = 1000;

    return {
      mvhd: moov.slice(mvhd.start, mvhd.end),
      trak: moov.slice(trak.start, trak.end),
      trex: trex ? moov.slice(trex.start, trex.end) : null,
      timescale: timescale,
    };
  }

  /** 在盒子内定位 tkhd / trex / mvhd 中 track_ID 的偏移 */
  function trackIdOffset(u8, b) {
    var ver = u8[b.body];
    if (b.type === 'tkhd') return b.body + (ver === 1 ? 20 : 12);
    if (b.type === 'trex') return b.body + 4;
    if (b.type === 'tfhd') return b.body + 4;
    return -1;
  }

  function setTrackId(boxBytes, id) {
    var top = boxes(boxBytes, 0, boxBytes.length);
    if (!top.length) return;
    var off = trackIdOffset(boxBytes, top[0]);
    if (off > 0) w32(boxBytes, off, id);
  }

  /* ----------------------------------------------------------------- 分片 */

  /** 读出下一个分片的 moof（已拷贝），并记录 mdat 总长与起始解码时间 */
  async function readFragment(src) {
    for (;;) {
      var head = await src.need(8);
      if (!head) return null;
      var size = u32(head, 0);
      var type = type4(head, 4);

      if (size === 1) {
        var big = await src.need(16);
        if (!big) return null;
        size = u64(big, 8);
      } else if (size === 0) {
        throw new Error('不支持长度为 0 的 ' + type + ' 盒子');
      }
      if (size < 8) throw new Error('盒子长度非法：' + type);

      if (type !== 'moof') {
        // sidx / styp / free / mdat 等：直接丢弃
        await src.skip(size);
        continue;
      }

      var moof = await src.take(size);
      var head2 = await src.need(8);
      if (!head2) throw new Error('moof 之后缺少 mdat');
      var mdatSize = u32(head2, 0);
      if (mdatSize === 1) {
        var h16 = await src.need(16);
        if (!h16) throw new Error('mdat 头部不完整');
        mdatSize = u64(h16, 8);
      }
      if (mdatSize < 8) throw new Error('mdat 长度非法');

      return { moof: moof, mdatSize: mdatSize, time: readDecodeTime(moof) };
    }
  }

  /** 读 moof 内 tfdt 的 baseMediaDecodeTime */
  function readDecodeTime(moof) {
    var value = 0;
    walk(moof, 8, moof.length, function (type, body) {
      if (type !== 'tfdt') return;
      value = moof[body] === 1 ? u64(moof, body + 4) : u32(moof, body + 4);
    });
    return value;
  }

  /** 就地改写 moof 的序号与 track_ID（长度不变） */
  function patchMoof(moof, trackId, seq) {
    walk(moof, 8, moof.length, function (type, body) {
      if (type === 'mfhd') w32(moof, body + 4, seq);
      else if (type === 'tfhd') w32(moof, body + 4, trackId);
    });
  }

  /* ------------------------------------------------------------------ 主流程 */

  function defaultFtyp() {
    // major_brand=isom, minor_version=512, compatible: isom/iso2/avc1/mp41
    var brands = 'isomiso2avc1mp41';
    var out = new Uint8Array(16 + brands.length);
    w32(out, 0, out.length);
    out[4] = 0x66; // f
    out[5] = 0x74; // t
    out[6] = 0x79; // y
    out[7] = 0x70; // p
    out[8] = 0x69; // i
    out[9] = 0x73; // s
    out[10] = 0x6f; // o
    out[11] = 0x6d; // m
    w32(out, 12, 512);
    for (var i = 0; i < brands.length; i++) out[16 + i] = brands.charCodeAt(i);
    return out;
  }

  /**
   * @param {Object} opts
   * @param {ByteSource} opts.video
   * @param {ByteSource} opts.audio
   * @param {Object} opts.sink    { write(Uint8Array): Promise|void }
   * @param {Function} [opts.onProgress]  ({written, videoBytes, audioBytes}) => void
   * @returns {Promise<{bytes:number}>}
   */
  async function mux(opts) {
    var video = opts.video;
    var audio = opts.audio;
    var sink = opts.sink;
    var onProgress = opts.onProgress || function () {};

    var vInit = parseInit((await readInit(video)).moov);
    var aInit = parseInit((await readInit(audio)).moov);

    var VIDEO_ID = 1;
    var AUDIO_ID = 2;

    var trakV = vInit.trak.slice(0);
    setTrackId(trakV, VIDEO_ID);

    var trakA = aInit.trak.slice(0);
    setTrackId(trakA, AUDIO_ID);

    var trexV = vInit.trex ? vInit.trex.slice(0) : buildTrex(VIDEO_ID, vInit.timescale);
    setTrackId(trexV, VIDEO_ID);

    var trexA = aInit.trex ? aInit.trex.slice(0) : buildTrex(AUDIO_ID, aInit.timescale);
    setTrackId(trexA, AUDIO_ID);

    // mvhd 的 next_track_ID 必须大于最大 track_ID
    var mvhd = vInit.mvhd.slice(0);
    var mvhdBody = mvhd[8] === 1 ? 8 + 4 + 8 + 8 + 4 + 8 + 4 + 2 + 2 + 8 + 36 + 24 : 8 + 4 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + 8 + 36 + 24;
    if (mvhdBody + 4 <= mvhd.length) w32(mvhd, mvhdBody, 3);

    var moov = box('moov', [mvhd, trakV, trakA, box('mvex', [trexV, trexA])]);

    await sink.write(defaultFtyp());
    await sink.write(moov);

    // 读到第一个分片
    var vFrag = await readFragment(video);
    var aFrag = await readFragment(audio);

    var seq = 0;
    var written = moov.length + 16;
    var vBytes = 0;
    var aBytes = 0;

    while (vFrag || aFrag) {
      var takeVideo;
      if (vFrag && aFrag) {
        var tv = vFrag.time / vInit.timescale;
        var ta = aFrag.time / aInit.timescale;
        takeVideo = tv <= ta;
      } else {
        takeVideo = !!vFrag;
      }

      if (takeVideo) {
        patchMoof(vFrag.moof, VIDEO_ID, ++seq);
        await sink.write(vFrag.moof);
        await video.copyTo(sink, vFrag.mdatSize);
        vBytes += vFrag.mdatSize;
        written += vFrag.moof.length + vFrag.mdatSize;
        vFrag = await readFragment(video);
      } else {
        patchMoof(aFrag.moof, AUDIO_ID, ++seq);
        await sink.write(aFrag.moof);
        await audio.copyTo(sink, aFrag.mdatSize);
        aBytes += aFrag.mdatSize;
        written += aFrag.moof.length + aFrag.mdatSize;
        aFrag = await readFragment(audio);
      }

      onProgress({ written: written, videoBytes: vBytes, audioBytes: aBytes, fragments: seq });
    }

    return { bytes: written, fragments: seq };
  }

  /** 源文件缺失 trex 时的兜底（极少数情况） */
  function buildTrex(trackId, timescale) {    var out = new Uint8Array(8 + 24);
    w32(out, 0, out.length);
    out[4] = 0x74; // t
    out[5] = 0x72; // r
    out[6] = 0x65; // e
    out[7] = 0x78; // x
    w32(out, 8, 0);
    w32(out, 12, trackId);
    w32(out, 16, 1); // default_sample_description_index
    w32(out, 20, 0); // default_sample_duration
    w32(out, 24, 0); // default_sample_size
    w32(out, 28, 0); // default_sample_flags
    return out;
  }

  /**
   * 单轨重封装：把多个首尾相接的 MP4 分段串成一个文件
   * （B 站 durl 模式在超长视频下会切成多段，每段各带 ftyp/moov）
   * 只保留第一段的初始化信息，后续段的 ftyp/moov/sidx 一律丢弃
   */
  async function remuxSingle(opts) {
    var src = opts.source;
    var sink = opts.sink;
    var onProgress = opts.onProgress || function () {};

    var init = await readInit(src);
    await sink.write(defaultFtyp());
    await sink.write(init.moov);

    var seq = 0;
    var written = init.moov.length + 16;
    var frag = await readFragment(src);
    if (!frag) throw new Error('该文件不是分片格式，无法重封装');

    while (frag) {
      patchMoof(frag.moof, 1, ++seq);
      await sink.write(frag.moof);
      await src.copyTo(sink, frag.mdatSize);
      written += frag.moof.length + frag.mdatSize;
      onProgress({ written: written, fragments: seq });
      frag = await readFragment(src);
    }
    return { bytes: written, fragments: seq };
  }

  /* --------------------------------------------------------------- 便利封装 */

  /** 从 Uint8Array 整体读入（小文件 / 测试用） */
  function sourceFromBytes(bytes) {
    var done = false;
    return new ByteSource(function () {
      if (done) return Promise.resolve(null);
      done = true;
      return Promise.resolve(bytes);
    });
  }

  /** 从 ReadableStream 读入（浏览器 / Node 的 stream.web） */
  function sourceFromStream(stream) {
    var reader = stream.getReader();
    return new ByteSource(function () {
      return reader.read().then(function (r) {
        return r.done ? null : r.value;
      });
    });
  }

  global.Fmp4Mux = {
    mux: mux,
    remuxSingle: remuxSingle,
    ByteSource: ByteSource,
    sourceFromBytes: sourceFromBytes,
    sourceFromStream: sourceFromStream,
    // 供测试使用
    _internal: { boxes: boxes, walk: walk, readFragment: readFragment, readInit: readInit, parseInit: parseInit },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
