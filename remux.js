// ═══════════════════════════════════════════════════════════════════
// remux.js — MPEG-TS → MP4 remuxer  (H.264 + AAC, no dependencies)
// ═══════════════════════════════════════════════════════════════════
'use strict';

// ── 1. Utility ──────────────────────────────────────────────────────────────

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Build an MP4 box: 4-byte big-endian size + 4-byte type + payload
function box(type, ...payloads) {
  const data = concat(...payloads.map(p => p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out  = new Uint8Array(8 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 8 + data.length);
  out[4]=type.charCodeAt(0); out[5]=type.charCodeAt(1);
  out[6]=type.charCodeAt(2); out[7]=type.charCodeAt(3);
  out.set(data, 8);
  return out;
}

function u8 (v)        { return new Uint8Array([v & 0xFF]); }
function u16(v)        { const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v>>>0); return b; }
function u32(v)        { const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v>>>0); return b; }
function u64(hi, lo)   { return concat(u32(hi), u32(lo)); }

function str4(s)       { return new Uint8Array([s.charCodeAt(0),s.charCodeAt(1),s.charCodeAt(2),s.charCodeAt(3)]); }

// ── 2. Bit reader (Exp-Golomb for SPS parsing) ──────────────────────────────

class BitReader {
  constructor(data) { this.d = data; this.bp = 0; this.byte = 0; }
  _byte()  { return (this.bp >> 3) < this.d.length ? this.d[this.bp >> 3] : 0; }
  read1()  { const v = (this._byte() >> (7 - (this.bp & 7))) & 1; this.bp++; return v; }
  readN(n) { let v=0; for(let i=0;i<n;i++) v=(v<<1)|this.read1(); return v; }
  readUE() { let m=0; while(!this.read1() && m<32) m++; return m===0?0:(1<<m)-1+this.readN(m); }
  readSE() { const v=this.readUE(); return v%2===0?-(v>>1):(v+1)>>1; }
  skipScalingList(size) {
    let lastScale=8, nextScale=8;
    for(let i=0;i<size;i++){
      if(nextScale!==0){const d=this.readSE();nextScale=(lastScale+d+256)%256;}
      lastScale=nextScale===0?lastScale:nextScale;
    }
  }
}

// ── 3. SPS parser → {width, height, profileIdc, levelIdc} ──────────────────

function parseSPS(nalData) {
  // nalData starts at NAL header byte; skip it
  const d   = nalData.subarray(1);
  const br  = new BitReader(d);
  const profileIdc = br.readN(8);
  br.readN(8); // constraint flags
  const levelIdc   = br.readN(8);
  br.readUE(); // seq_parameter_set_id

  const highProfiles = [100,110,122,244,44,83,86,118,128,138,139,134,135];
  if (highProfiles.includes(profileIdc)) {
    const chromaFmt = br.readUE();
    if (chromaFmt === 3) br.readN(1);
    br.readUE(); br.readUE(); br.readN(1);
    if (br.readN(1)) { // seq_scaling_matrix_present
      for (let i=0;i<(chromaFmt!==3?8:12);i++) {
        if(br.readN(1)) br.skipScalingList(i<6?16:64);
      }
    }
  }

  br.readUE(); // log2_max_frame_num_minus4
  const picOrderType = br.readUE();
  if (picOrderType===0) br.readUE();
  else if (picOrderType===1) {
    br.readN(1); br.readSE(); br.readSE();
    const n=br.readUE(); for(let i=0;i<n;i++) br.readSE();
  }
  br.readUE(); // max_num_ref_frames
  br.readN(1); // gaps_in_frame_num_value_allowed_flag

  const wMbs   = br.readUE() + 1;
  const hMbsMU = br.readUE() + 1;
  const frameMbsOnly = br.readN(1);
  if (!frameMbsOnly) br.readN(1);
  br.readN(1); // direct_8x8_inference_flag

  let cropL=0, cropR=0, cropT=0, cropB=0;
  if (br.readN(1)) { // frame_cropping_flag
    cropL=br.readUE(); cropR=br.readUE(); cropT=br.readUE(); cropB=br.readUE();
  }

  const cropUnitX = 2;
  const cropUnitY = frameMbsOnly ? 2 : 4;
  const width  = wMbs   * 16 - (cropL + cropR) * cropUnitX;
  const height = hMbsMU * 16 - (cropT + cropB) * cropUnitY;

  return { width: width||1280, height: height||720, profileIdc, levelIdc };
}

// ── 4. MPEG-TS demuxer ──────────────────────────────────────────────────────

const TS_SYNC = 0x47;
const TS_SIZE = 188;

// Returns { videoSamples, audioSamples, sps, pps, audioConfig }
function demuxTS(buffer) {
  const data = new Uint8Array(buffer);

  // Locate first sync byte
  let start = 0;
  while (start < data.length && data[start] !== TS_SYNC) start++;

  let pmtPid   = -1;
  let videoPid = -1;
  let audioPid = -1;

  // PID → { bufs: [], pts, dts }  (accumulate TS payload until PUSI)
  const pesBuffers = new Map();

  const videoSamples = []; // { nalUnits, pts, dts, isKey }
  const audioSamples = []; // { frames: [{data, header}], pts }

  let sps = null, pps = null;
  let audioConfig = null;

  function readPTS(buf, offset) {
    // PTS/DTS: 5 bytes, bits distributed as:
    // X0XH XHHL XHLL XLLL XLLL where X=marker, H=high, L=low
    const b0 = buf[offset];
    const hi  = ((b0 & 0x0E) * 0x10000000) +
                ((buf[offset+1] & 0xFF) * 0x200000) +
                ((buf[offset+2] & 0xFE) * 0x8000) +
                ((buf[offset+3] & 0xFF) * 0x100) +
                ((buf[offset+4] & 0xFE) >> 1);
    // Use low 32 bits safe integer math
    return ((b0 & 0x0E) << 28) | ((buf[offset+1]) << 20) |
           ((buf[offset+2] & 0xFE) << 12) | (buf[offset+3] << 5) |
           ((buf[offset+4] & 0xFE) >> 2);
  }

  // Full 33-bit PTS using floating point to avoid integer overflow
  function readPTS33(buf, offset) {
    return (((buf[offset]   & 0x0E) / 2) * Math.pow(2,29)) +
            ((buf[offset+1] & 0xFF)       * Math.pow(2,22)) +
           (((buf[offset+2] & 0xFE) / 2) * Math.pow(2,14)) +
            ((buf[offset+3] & 0xFF)       * Math.pow(2, 7)) +
           (((buf[offset+4] & 0xFE) / 2));
  }

  function parsePES(pid, rawBytes) {
    const d   = rawBytes;
    if (d.length < 9) return;
    // PES start code check
    if (d[0]!==0||d[1]!==0||d[2]!==1) return;

    const headerDataLen = d[8];
    const flags         = d[7];
    let pts = null, dts = null;

    let hOff = 9;
    if ((flags & 0x80) && d.length > hOff + 4) {
      pts = readPTS33(d, hOff); hOff += 5;
    }
    if ((flags & 0x40) && d.length > hOff + 4) {
      dts = readPTS33(d, hOff); hOff += 5;
    }
    if (dts === null) dts = pts;

    const pesHdrEnd = 9 + headerDataLen;
    if (pesHdrEnd > d.length) return;
    const payload = d.subarray(pesHdrEnd);

    if (pid === videoPid) {
      const nalUnits = splitAnnexB(payload);
      let isKey = false;
      for (const nal of nalUnits) {
        const nalType = nal[0] & 0x1F;
        if (nalType === 5) isKey = true;
        if (nalType === 7 && !sps) sps = nal;
        if (nalType === 8 && !pps) pps = nal;
      }
      if (pts !== null) {
        videoSamples.push({ nalUnits, pts, dts, isKey });
      }
    } else if (pid === audioPid) {
      const frames = parseADTS(payload);
      if (frames.length > 0 && pts !== null) {
        if (!audioConfig) audioConfig = frames[0].config;
        audioSamples.push({ frames, pts });
      }
    }
  }

  function flushPES(pid) {
    const state = pesBuffers.get(pid);
    if (state && state.bufs.length > 0) {
      parsePES(pid, concat(...state.bufs));
    }
    pesBuffers.set(pid, { bufs: [], pts: null, dts: null });
  }

  // Process all TS packets
  for (let pos = start; pos + TS_SIZE <= data.length; pos += TS_SIZE) {
    if (data[pos] !== TS_SYNC) continue;

    const pid  = ((data[pos+1] & 0x1F) << 8) | data[pos+2];
    const pusi = (data[pos+1] >> 6) & 1;
    const afc  = (data[pos+3] & 0x30) >> 4;
    const hasAF = (afc & 2) !== 0;
    const hasPL = (afc & 1) !== 0;

    if (!hasPL) continue;

    let plStart = pos + 4;
    if (hasAF) plStart += 1 + data[pos+4]; // skip adaptation field

    if (plStart >= pos + TS_SIZE) continue;
    const payload = data.subarray(plStart, pos + TS_SIZE);

    if (pid === 0x0000) {
      // PAT
      const sectionLen = ((data[plStart+1+2] & 0x0F) << 8) | data[plStart+1+3];
      for (let i = plStart+1+8; i < plStart+1+8+(sectionLen-9); i+=4) {
        const progNum = (data[i]<<8)|data[i+1];
        if (progNum !== 0) { pmtPid = ((data[i+2]&0x1F)<<8)|data[i+3]; break; }
      }
    } else if (pid === pmtPid) {
      // PMT
      const sStart = plStart + (pusi ? 1 : 0);
      const sectionLen  = ((data[sStart+1]&0x0F)<<8)|data[sStart+2];
      const prgInfoLen  = ((data[sStart+10]&0x0F)<<8)|data[sStart+11];
      let si = sStart + 12 + prgInfoLen;
      const sEnd = sStart + 3 + sectionLen - 4; // -4 for CRC
      while (si + 4 < sEnd && si < data.length) {
        const sType = data[si];
        const sPid  = ((data[si+1]&0x1F)<<8)|data[si+2];
        const esLen = ((data[si+3]&0x0F)<<8)|data[si+4];
        // 0x1B=H.264, 0x24=H.265, 0x0F=AAC ADTS, 0x11=AAC LATM
        if ((sType===0x1B||sType===0x24) && videoPid<0) videoPid=sPid;
        if ((sType===0x0F||sType===0x11) && audioPid<0) audioPid=sPid;
        si += 5 + esLen;
      }
    } else if (pid===videoPid || pid===audioPid) {
      if (pusi) {
        flushPES(pid);
        pesBuffers.set(pid, { bufs: [new Uint8Array(payload)], pts:null, dts:null });
      } else {
        const state = pesBuffers.get(pid);
        if (state) state.bufs.push(new Uint8Array(payload));
      }
    }
  }

  // Flush remaining
  if (videoPid >= 0) flushPES(videoPid);
  if (audioPid >= 0) flushPES(audioPid);

  return { videoSamples, audioSamples, sps, pps, audioConfig };
}

// Split H.264 Annex B byte stream into NAL units
function splitAnnexB(data) {
  const nals = [];
  let i = 0;
  while (i < data.length - 4) {
    // Find start code: 00 00 01 or 00 00 00 01
    if (data[i]===0 && data[i+1]===0) {
      if (data[i+2]===1) {
        i += 3;
      } else if (data[i+2]===0 && data[i+3]===1) {
        i += 4;
      } else { i++; continue; }

      // Find end of this NAL
      let end = data.length;
      for (let j=i; j<data.length-3; j++) {
        if (data[j]===0 && data[j+1]===0 && (data[j+2]===1||(data[j+2]===0&&data[j+3]===1))) {
          end = j; break;
        }
      }
      if (end > i) nals.push(data.subarray(i, end));
      i = end;
    } else { i++; }
  }
  return nals;
}

// Remove emulation prevention bytes (03) from RBSP
function removeEPB(data) {
  const out = new Uint8Array(data.length);
  let j = 0;
  for (let i=0; i<data.length; i++) {
    if (i>=2 && data[i-2]===0 && data[i-1]===0 && data[i]===3 && i+1<data.length && data[i+1]<=3) {
      continue;
    }
    out[j++] = data[i];
  }
  return out.subarray(0, j);
}

// Parse ADTS stream → [{data: rawAACFrame, config: Uint8Array(2)}]
const AAC_SAMPLE_RATES = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];

function parseADTS(data) {
  const frames = [];
  let i = 0;
  while (i < data.length - 7) {
    // Sync word: 0xFFF
    if (data[i]!==0xFF || (data[i+1]&0xF0)!==0xF0) { i++; continue; }

    const protAbsent   = data[i+1] & 1;
    const profile      = (data[i+2] >> 6) & 0x3;           // 0=Main, 1=LC, 2=SSR
    const sriIdx       = (data[i+2] >> 2) & 0xF;
    const chanConf     = ((data[i+2]&1)<<2) | ((data[i+3]>>6)&3);
    const frameLen     = ((data[i+3]&3)<<11) | (data[i+4]<<3) | ((data[i+5]>>5)&7);
    const headerLen    = protAbsent ? 7 : 9;

    if (frameLen < headerLen || i + frameLen > data.length) { i++; continue; }

    const rawFrame = data.subarray(i + headerLen, i + frameLen);

    // Build 2-byte AudioSpecificConfig
    const audioObjectType = profile + 1;
    const config = new Uint8Array(2);
    config[0] = ((audioObjectType & 0x1F) << 3) | ((sriIdx >> 1) & 0x7);
    config[1] = ((sriIdx & 1) << 7) | ((chanConf & 0xF) << 3);

    frames.push({
      data: rawFrame,
      config,
      sampleRate: AAC_SAMPLE_RATES[sriIdx] || 44100,
      channels:   chanConf || 2,
    });

    i += frameLen;
  }
  return frames;
}

// ── 5. MP4 box builders ─────────────────────────────────────────────────────

function ftyp() {
  return box('ftyp',
    str4('isom'), u32(0x200),
    str4('isom'), str4('iso2'), str4('avc1'), str4('mp41')
  );
}

function mvhd(durationMs) {
  // version=0, timescale=1000
  return box('mvhd',
    u32(0), u32(0), u32(0),   // version, ctime, mtime
    u32(1000),                 // timescale
    u32(durationMs),           // duration
    u32(0x00010000),           // rate = 1.0
    u16(0x0100), u16(0),       // volume = 1.0, reserved
    new Uint8Array(8),         // reserved
    // identity matrix
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    new Uint8Array(24),        // pre_defined
    u32(0xFFFFFFFF)            // next_track_id (auto)
  );
}

function tkhd(trackId, durationMs, width, height, isVideo) {
  // flags: 0x3 = enabled + in-movie
  return box('tkhd',
    u32(0x00000003),      // version=0, flags=3
    u32(0), u32(0),       // ctime, mtime
    u32(trackId),
    u32(0),               // reserved
    u32(durationMs),
    new Uint8Array(8),    // reserved
    u16(0), u16(0),       // layer, alternate_group
    u16(isVideo?0:0x0100), u16(0), // volume
    new Uint8Array(2),    // reserved
    // matrix
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    // width, height (16.16 fixed point)
    u32(isVideo ? width<<16 : 0),
    u32(isVideo ? height<<16: 0)
  );
}

function mdhd(durationTicks, timescale) {
  return box('mdhd',
    u32(0), u32(0), u32(0), // version, ctime, mtime
    u32(timescale),
    u32(durationTicks),
    u16(0x55C4),            // language = 'und'
    u16(0)                  // pre_defined
  );
}

function hdlr(type) {
  const isVideo = type === 'vide';
  return box('hdlr',
    u32(0), u32(0),
    str4(isVideo ? 'vide' : 'soun'),
    new Uint8Array(12),
    new Uint8Array(isVideo ? 14 : 13) // null-terminated name
  );
}

function dinf() {
  return box('dinf',
    box('dref', u32(0), u32(1), // version=0, entry_count=1
      box('url ', u32(1))       // flags=1 (self-contained)
    )
  );
}

function stsd_video(spsNal, ppsNal, width, height, profileIdc, levelIdc) {
  // avcC box
  const avcC = box('avcC',
    new Uint8Array([
      1,                          // configurationVersion
      profileIdc,
      0,                          // profile_compatibility
      levelIdc,
      0xFF,                       // lengthSizeMinusOne = 3 (4-byte lengths)
      0xE1,                       // numSequenceParameterSets = 1
    ]),
    u16(spsNal.length), spsNal,
    new Uint8Array([1]),          // numPictureParameterSets = 1
    u16(ppsNal.length), ppsNal
  );

  // avc1 sample entry
  const avc1 = box('avc1',
    new Uint8Array(6),            // reserved
    u16(1),                       // data_reference_index
    new Uint8Array(16),           // pre_defined + reserved
    u16(width), u16(height),
    u32(0x00480000),              // horiz resolution 72dpi
    u32(0x00480000),              // vert resolution 72dpi
    u32(0),                       // reserved
    u16(1),                       // frame_count
    new Uint8Array(32),           // compressorname
    u16(0x0018), u16(0xFFFF),     // depth, pre_defined
    avcC
  );

  return box('stsd', u32(0), u32(1), avc1);
}

function stsd_audio(audioConfig, sampleRate, channels) {
  // esds box (MPEG-4 Audio)
  const esds = box('esds',
    u32(0), // version+flags
    new Uint8Array([
      // ES_Descriptor tag=3
      0x03, 0x19 + audioConfig.length,
      0x00, 0x00,   // ES_ID
      0x00,         // flags
      // DecoderConfigDescriptor tag=4
      0x04, 0x11 + audioConfig.length,
      0x40,         // objectTypeIndication = Audio ISO/IEC 14496-3
      0x15,         // streamType=5(audio)<<2|1
      0x00, 0x00, 0x00, // bufferSizeDB
      0x00, 0x01, 0xF4, 0x00, // maxBitrate
      0x00, 0x01, 0xF4, 0x00, // avgBitrate
      // DecoderSpecificInfo tag=5
      0x05, audioConfig.length,
    ]),
    audioConfig,
    new Uint8Array([
      // SLConfigDescriptor tag=6
      0x06, 0x01, 0x02
    ])
  );

  const mp4a = box('mp4a',
    new Uint8Array(6),        // reserved
    u16(1),                   // data_reference_index
    new Uint8Array(8),        // reserved
    u16(channels),
    u16(16),                  // sample size
    u16(0), u16(0),           // compression_id, packet_size
    u32(sampleRate << 16),    // sampleRate (16.16 fixed)
    esds
  );

  return box('stsd', u32(0), u32(1), mp4a);
}

// Build stts from array of durations
function stts(durations) {
  const entries = [];
  let i = 0;
  while (i < durations.length) {
    let count = 1;
    while (i+count < durations.length && durations[i+count] === durations[i]) count++;
    entries.push(u32(count), u32(durations[i]));
    i += count;
  }
  return box('stts', u32(0), u32(entries.length/2), ...entries);
}

// Build ctts (composition time offsets = pts - dts)
function ctts(offsets) {
  if (offsets.every(o => o === 0)) return new Uint8Array(0);
  const entries = [];
  let i = 0;
  while (i < offsets.length) {
    let count = 1;
    while (i+count < offsets.length && offsets[i+count] === offsets[i]) count++;
    entries.push(u32(count), u32(offsets[i]));
    i += count;
  }
  return box('ctts', u32(0), u32(entries.length/2), ...entries);
}

// stss: keyframe sample numbers (1-based)
function stss(keyframes) {
  return box('stss', u32(0), u32(keyframes.length), ...keyframes.map(u32));
}

// stsz: sample sizes
function stsz(sizes) {
  return box('stsz', u32(0), u32(0), u32(sizes.length), ...sizes.map(u32));
}

// stsc: sample-to-chunk (one sample per chunk → trivial)
function stsc_onePerChunk() {
  // one entry: first_chunk=1, samples_per_chunk=1, description_index=1
  return box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1));
}

// stco: chunk offsets
function stco(offsets) {
  return box('stco', u32(0), u32(offsets.length), ...offsets.map(u32));
}

// ── 6. Full track builder ────────────────────────────────────────────────────

function buildVideoTrack(trackId, videoSamples, spsNal, ppsNal, durationMs) {
  if (!spsNal || !ppsNal || videoSamples.length === 0) return null;

  const cleanSPS = removeEPB(spsNal.length > 1 ? spsNal.subarray(0) : spsNal);
  let spsMeta;
  try { spsMeta = parseSPS(cleanSPS); }
  catch(e) { spsMeta = { width:1280, height:720, profileIdc:100, levelIdc:40 }; }

  const timescale = 90000;
  const samples   = []; // { avcc: Uint8Array, pts, dts, isKey }

  for (const s of videoSamples) {
    // Convert NAL units from Annex B to AVCC (4-byte length prefix)
    const nalBufs = [];
    for (const nal of s.nalUnits) {
      const t = nal[0] & 0x1F;
      if (t === 9 || t === 0) continue; // skip AUD + zero-length
      nalBufs.push(u32(nal.length), nal);
    }
    if (nalBufs.length === 0) continue;
    const avcc = concat(...nalBufs);
    samples.push({ avcc, pts: Math.round(s.pts), dts: Math.round(s.dts), isKey: s.isKey });
  }
  if (samples.length === 0) return null;

  // Sort by DTS
  samples.sort((a,b) => a.dts - b.dts);

  // Durations: DTS[i+1] - DTS[i]; last sample gets average
  const durations = [];
  for (let i=0; i<samples.length-1; i++) {
    const d = samples[i+1].dts - samples[i].dts;
    durations.push(d > 0 ? d : 3000); // fallback 30fps
  }
  const avgDur = durations.length > 0
    ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length)
    : 3000;
  durations.push(avgDur);

  const totalTicks = durations.reduce((a,b)=>a+b,0);
  const cttsOffsets = samples.map(s => {
    const o = (s.pts - s.dts);
    return o >= 0 ? o : 0;
  });

  const keyframes = samples.map((s,i)=>s.isKey?i+1:null).filter(Boolean);
  const sizes     = samples.map(s=>s.avcc.length);
  // chunk offsets filled in later after mdat position known
  const chunkOffsets = samples.map(()=>0);

  const cttsBox = ctts(cttsOffsets);
  const stblParts = [
    stsd_video(spsNal, ppsNal, spsMeta.width, spsMeta.height, spsMeta.profileIdc, spsMeta.levelIdc),
    stts(durations),
    ...(cttsBox.length > 0 ? [cttsBox] : []),
    ...(keyframes.length > 0 ? [stss(keyframes)] : []),
    stsc_onePerChunk(),
    stsz(sizes),
    stco(chunkOffsets),
  ];

  const trak = box('trak',
    tkhd(trackId, durationMs, spsMeta.width, spsMeta.height, true),
    box('mdia',
      mdhd(totalTicks, timescale),
      hdlr('vide'),
      box('minf',
        box('vmhd', u32(1), u32(0)), // version=0,flags=1, graphicsMode+opcolor
        dinf(),
        box('stbl', ...stblParts)
      )
    )
  );

  const rawData = concat(...samples.map(s=>s.avcc));
  return { trak, rawData, chunkOffsets, sampleCount: samples.length };
}

function buildAudioTrack(trackId, audioSamples, audioConfig, durationMs) {
  if (!audioConfig || audioSamples.length === 0) return null;

  const sampleRate = AAC_SAMPLE_RATES[
    ((audioConfig[0] & 0x07) << 1) | ((audioConfig[1] >> 7) & 1)
  ] || 44100;
  const channels   = (audioConfig[1] >> 3) & 0xF || 2;
  const timescale  = sampleRate;
  const frameSamples = 1024; // AAC frame size

  const frames = [];
  for (const sample of audioSamples) {
    for (const f of sample.frames) {
      if (f.data.length > 0) frames.push(f.data);
    }
  }
  if (frames.length === 0) return null;

  const totalTicks = frames.length * frameSamples;
  const sizes      = frames.map(f=>f.length);
  const chunkOffsets = frames.map(()=>0); // filled later

  const trak = box('trak',
    tkhd(trackId, durationMs, 0, 0, false),
    box('mdia',
      mdhd(totalTicks, timescale),
      hdlr('soun'),
      box('minf',
        box('smhd', u32(0), u32(0)),
        dinf(),
        box('stbl',
          stsd_audio(audioConfig, sampleRate, channels),
          stts(new Array(frames.length).fill(frameSamples)),
          stsc_onePerChunk(),
          stsz(sizes),
          stco(chunkOffsets)
        )
      )
    )
  );

  const rawData = concat(...frames);
  return { trak, rawData, chunkOffsets, sampleCount: frames.length };
}

// Patch stco offsets inside a built trak box
function patchStco(trakBox, offsets) {
  // Find 'stco' box inside trakBox and overwrite its chunk offsets
  const d    = trakBox;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = 0;
  while (i < d.length - 8) {
    const size = view.getUint32(i);
    const type = String.fromCharCode(d[i+4],d[i+5],d[i+6],d[i+7]);
    if (type === 'stco') {
      // stco: version(4) + flags(4 in u32) + entry_count(4) + entries
      const count = view.getUint32(i + 8 + 4);
      for (let e=0; e<count && e<offsets.length; e++) {
        view.setUint32(i + 8 + 8 + e*4, offsets[e]);
      }
      return;
    }
    if (size < 8) break;
    i += size;
  }
}

// ── 7. Main remux entry point ────────────────────────────────────────────────

function remuxTStoMP4(tsBuffer) {
  const { videoSamples, audioSamples, sps, pps, audioConfig } = demuxTS(tsBuffer);

  if (videoSamples.length === 0 && audioSamples.length === 0) {
    throw new Error('No video or audio samples found in TS stream');
  }

  // Calculate duration
  let durationMs = 0;
  if (videoSamples.length >= 2) {
    const first = videoSamples[0].pts;
    const last  = videoSamples[videoSamples.length-1].pts;
    durationMs  = Math.round((last - first) / 90) + 33; // +1 frame
  } else if (audioSamples.length >= 2) {
    const first = audioSamples[0].pts;
    const last  = audioSamples[audioSamples.length-1].pts;
    durationMs  = Math.round((last - first) / 90) + 23;
  }
  durationMs = Math.max(durationMs, 1000);

  const ftypBox = ftyp();

  const videoTrack = sps && pps ? buildVideoTrack(1, videoSamples, sps, pps, durationMs) : null;
  const audioTrack = audioConfig ? buildAudioTrack(videoTrack?2:1, audioSamples, audioConfig, durationMs) : null;

  if (!videoTrack && !audioTrack) {
    throw new Error('Could not build any tracks from TS data');
  }

  // mdat layout: ftyp | mdat_box | moov
  // mdat starts at: ftypBox.length
  // mdat data starts at: ftypBox.length + 8 (box header)
  const mdatDataStart = ftypBox.length + 8;

  // Calculate chunk offsets for video
  let videoOffset = mdatDataStart;
  if (videoTrack) {
    let off = videoOffset;
    // each sample is one chunk
    const offsets = [];
    let cursor = 0;
    const view = new DataView(videoTrack.rawData.buffer, videoTrack.rawData.byteOffset);
    // We need per-sample sizes - rebuild from the raw data using the stco approach
    // Since each sample is one chunk, offsets[i] = videoOffset + sum of sizes 0..i-1
    // We need sample sizes - get them from rawData lengths
    // Reconstruct: sample avcc boundaries
    // Actually since we built rawData = concat(samples[0].avcc, samples[1].avcc, ...)
    // and we have sizes in stsz, we can compute offsets directly
    // We'll pass sizes through the track object
    for (let i=0; i<videoTrack.sampleCount; i++) {
      offsets.push(off);
      // Advance by sample size - we need sizes from the box
      // Simple workaround: rebuild from trak box itself
      // Actually, we already have sizes in the stbl - just use mdatDataStart + cumulative sizes
      // We'll compute this below after rebuilding
      break; // Just compute once
    }
  }

  // Simpler approach: collect sample sizes from the track objects directly
  const videoSizes = videoTrack ? getStszSizes(videoTrack.trak) : [];
  const audioSizes = audioTrack ? getStszSizes(audioTrack.trak) : [];

  // Compute chunk offsets
  if (videoTrack) {
    let off = mdatDataStart;
    const offsets = [];
    for (const sz of videoSizes) { offsets.push(off); off += sz; }
    patchStco(videoTrack.trak, offsets);
  }

  const videoDataSize = videoTrack ? videoTrack.rawData.length : 0;
  const audioStart    = mdatDataStart + videoDataSize;

  if (audioTrack) {
    let off = audioStart;
    const offsets = [];
    for (const sz of audioSizes) { offsets.push(off); off += sz; }
    patchStco(audioTrack.trak, offsets);
  }

  // Build moov
  const tracks = [videoTrack, audioTrack].filter(Boolean);
  const moovBox = box('moov',
    mvhd(durationMs),
    ...tracks.map(t => t.trak)
  );

  // Build mdat
  const mdatPayload = concat(
    ...[videoTrack, audioTrack].filter(Boolean).map(t=>t.rawData)
  );
  const mdatBox = box('mdat', mdatPayload);

  return concat(ftypBox, mdatBox, moovBox);
}

// Extract sample sizes from a built trak box's stsz
function getStszSizes(trakBox) {
  const d    = trakBox;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = 0;
  while (i < d.length - 8) {
    const size = view.getUint32(i);
    const type = String.fromCharCode(d[i+4],d[i+5],d[i+6],d[i+7]);
    if (type === 'stsz') {
      const sampleSize  = view.getUint32(i + 8 + 4); // constant size (0 = variable)
      const sampleCount = view.getUint32(i + 8 + 8);
      if (sampleSize > 0) return new Array(sampleCount).fill(sampleSize);
      const sizes = [];
      for (let e=0; e<sampleCount; e++) sizes.push(view.getUint32(i + 8 + 12 + e*4));
      return sizes;
    }
    if (size < 8) break;
    i += size;
  }
  return [];
}

// Fix stts() call for audio (was using reduce incorrectly)
// Override the audio stts generation:
function buildAudioStts(frameCount) {
  return stts(new Array(frameCount).fill(1024));
}

// ── Export ──────────────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined') globalThis.remuxTStoMP4 = remuxTStoMP4;
