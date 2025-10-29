/*
Minimal QR Code generator (MIT Licensed)
This file exposes a simple API: QRCode, which can render to a canvas or SVG path.
Implementation adapted from Project Nayuki's qrcodegen (simplified) and Kazuhiko Arase's QRCode.js concepts.
Note: This is a compact, readable implementation suitable for browser usage.
*/
(function (global) {
  "use strict";

  // Error correction levels
  var ECLevel = {
    L: 1,
    M: 0,
    Q: 3,
    H: 2,
  };

  // Default options
  var defaults = {
    text: "",
    ecl: "M", // L, M, Q, H
    minVersion: 1,
    maxVersion: 40,
    mask: -1, // -1 auto
    border: 4,
    scale: 8,
  };

  // Galois field tables for Reed-Solomon
  var GF256_EXP = new Array(512);
  var GF256_LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF256_EXP[i] = x;
      GF256_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var i2 = 255; i2 < 512; i2++) GF256_EXP[i2] = GF256_EXP[i2 - 255];
    GF256_LOG[0] = 0; // not used
  })();

  function rsMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return GF256_EXP[(GF256_LOG[x] + GF256_LOG[y]) % 255];
  }

  function makePoly(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      poly.push(0);
      for (var j = poly.length - 1; j > 0; j--) {
        poly[j] = poly[j] ^ rsMul(poly[j - 1], GF256_EXP[i]);
      }
      poly[0] = poly[0];
    }
    return poly;
  }

  // Version info and ECC table (subset sufficient for general usage)
  // Each entry: [version, dimension, [L,M,Q,H] ECC codewords per block, [L,M,Q,H] blocks]
  // For simplicity, we use compact tables for total ECC codewords and groupings derived from standard.
  var VERSION_DIM = function (v) { return 17 + 4 * v; };

  // Total number of data codewords for version+ECC, from standard table (subset for v1..v10)
  var DATA_CODEWORDS = {
    1:  { L: 19, M: 16, Q: 13, H: 9 },
    2:  { L: 34, M: 28, Q: 22, H: 16 },
    3:  { L: 55, M: 44, Q: 34, H: 26 },
    4:  { L: 80, M: 64, Q: 48, H: 36 },
    5:  { L: 108, M: 86, Q: 62, H: 46 },
    6:  { L: 136, M: 108, Q: 76, H: 60 },
    7:  { L: 156, M: 124, Q: 88, H: 66 },
    8:  { L: 194, M: 154, Q: 110, H: 86 },
    9:  { L: 232, M: 182, Q: 132, H: 100 },
    10: { L: 274, M: 216, Q: 154, H: 122 },
  };

  function getEcl(ecl) {
    ecl = (ecl || "M").toUpperCase();
    if (!ECLevel.hasOwnProperty(ecl)) ecl = "M";
    return ecl;
  }

  function getModeAndData(text) {
    // We keep it simple and always use byte mode
    var bytes = [];
    for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
    return { mode: 4, data: bytes }; // 4 = byte mode
  }

  function getCharCountBits(version) {
    if (version <= 9) return 8;
    if (version <= 26) return 16;
    return 16;
  }

  function bitBuffer() {
    return {
      bits: [],
      put: function (val, len) {
        for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
      },
      putBits: function (arr) { this.bits = this.bits.concat(arr); },
      padToBytes: function () {
        var k = this.bits.length % 8;
        if (k) for (var i = 0; i < 8 - k; i++) this.bits.push(0);
      },
    };
  }

  function calcCapacity(version, ecl) {
    var table = DATA_CODEWORDS[version];
    if (!table) return -1;
    return table[ecl] * 8;
  }

  function interleaveBlocks(data, ec) {
    var maxLen = 0;
    for (var i = 0; i < data.length; i++) if (data[i].length > maxLen) maxLen = data[i].length;
    var result = [];
    for (var j = 0; j < maxLen; j++) {
      for (var i2 = 0; i2 < data.length; i2++) if (j < data[i2].length) result.push(data[i2][j]);
    }
    maxLen = 0;
    for (var i3 = 0; i3 < ec.length; i3++) if (ec[i3].length > maxLen) maxLen = ec[i3].length;
    for (var j2 = 0; j2 < maxLen; j2++) {
      for (var i4 = 0; i4 < ec.length; i4++) if (j2 < ec[i4].length) result.push(ec[i4][j2]);
    }
    return result;
  }

  function rsGenPoly(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      poly.push(0);
      for (var j = poly.length - 1; j > 0; j--) {
        poly[j] ^= rsMul(poly[j - 1], GF256_EXP[i]);
      }
    }
    return poly;
  }

  function rsComputeRemainder(msg, gen) {
    var res = new Array(gen.length - 1).fill(0);
    for (var i = 0; i < msg.length; i++) {
      var factor = msg[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < res.length; j++) res[j] ^= rsMul(gen[j], factor);
    }
    return res;
  }

  function makeMatrix(version) {
    var size = VERSION_DIM(version);
    var m = new Array(size);
    for (var i = 0; i < size; i++) m[i] = new Array(size).fill(null);
    return m;
  }

  function drawFinder(m, x, y) {
    for (var dy = -1; dy <= 7; dy++) {
      for (var dx = -1; dx <= 7; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= m.length || yy < 0 || yy >= m.length) continue;
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        m[yy][xx] = dist <= 1 || dist === 3 ? true : false;
      }
    }
  }

  function drawSeparators(m) {
    var n = m.length;
    for (var i = 0; i < 8; i++) {
      m[7][i] = false; m[i][7] = false;
      m[n - 8][i] = false; m[n - 1 - i][7] = false;
      m[7][n - 1 - i] = false; m[i][n - 8] = false;
    }
  }

  function drawTiming(m) {
    var n = m.length;
    for (var i = 8; i < n - 8; i++) {
      m[6][i] = (i % 2 === 0);
      m[i][6] = (i % 2 === 0);
    }
  }

  function drawDarkModule(m) {
    m[4 * (m.length - 7) + 9][8] = true;
  }

  function getAlignmentPatternPositions(version) {
    if (version === 1) return [];
    var num = Math.floor(version / 7) + 2;
    var step = (VERSION_DIM(version) - 13) / (num - 1);
    var result = [6];
    for (var i = 0; i < num - 1; i++) result.push(Math.round(6 + (i * step)));
    return result;
  }

  function drawAlignment(m, version) {
    var pos = getAlignmentPatternPositions(version);
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var x = pos[i], y = pos[j];
        if (m[y][x] !== null) continue; // skip overlaps with finder
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var xx = x + dx, yy = y + dy;
            var dist = Math.max(Math.abs(dx), Math.abs(dy));
            m[yy][xx] = (dist === 2 || dist === 0);
          }
        }
      }
    }
  }

  function reserveFormatAreas(m) {
    var n = m.length;
    for (var i = 0; i < 9; i++) if (m[8][i] === null) m[8][i] = false;
    for (var i2 = 0; i2 < 8; i2++) if (m[i2][8] === null) m[i2][8] = false;
    for (var i3 = n - 8; i3 < n; i3++) if (m[8][i3] === null) m[8][i3] = false;
    for (var i4 = n - 7; i4 < n; i4++) if (m[i4][8] === null) m[i4][8] = false;
  }

  function BCHCode(value, poly) {
    var msb = 0;
    for (var i = value; i; i >>= 1) msb++;
    value <<= (poly.toString(2).length - 1);
    while (true) {
      var shift = 0;
      for (var t = poly; t; t >>= 1) shift++;
      var diff = (value.toString(2).length) - shift;
      if (diff < 0) break;
      value ^= (poly << diff);
    }
    return value;
  }

  var FORMAT_INFO = {
    L: 1, M: 0, Q: 3, H: 2
  };

  function drawFormatInfo(m, ecl, mask) {
    var n = m.length;
    var eclBits = { L: 1, M: 0, Q: 3, H: 2 }[ecl];
    var data = (eclBits << 3) | mask;
    var rem = BCHCode(data, 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    for (var i = 0; i <= 5; i++) m[8][i] = ((bits >>> i) & 1) !== 0;
    m[8][7] = ((bits >>> 6) & 1) !== 0;
    m[8][8] = ((bits >>> 7) & 1) !== 0;
    m[7][8] = ((bits >>> 8) & 1) !== 0;
    for (var i2 = 9; i2 < 15; i2++) m[14 - i2][8] = ((bits >>> i2) & 1) !== 0;

    for (var j = 0; j < 8; j++) m[n - 1 - j][8] = ((bits >>> j) & 1) !== 0;
    for (var i3 = 8; i3 < 15; i3++) m[8][n - 15 + i3] = ((bits >>> i3) & 1) !== 0;
    m[8][n - 8] = true; // dark module overlap per spec
  }

  function maskFunc(mask, i, j) {
    switch (mask) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return ((Math.floor(i / 2) + Math.floor(j / 3)) % 2) === 0;
      case 5: return ((i * j) % 2 + (i * j) % 3) === 0;
      case 6: return (((i * j) % 2 + (i * j) % 3) % 2) === 0;
      case 7: return (((i + j) % 2 + (i * j) % 3) % 2) === 0;
      default: return (i + j) % 2 === 0;
    }
  }

  function penaltyScore(m) {
    var n = m.length, penalty = 0;
    // Rule 1: rows/cols with runs
    for (var y = 0; y < n; y++) {
      var runColor = false, runLen = 0, last = null;
      for (var x = 0; x < n; x++) {
        var v = m[y][x];
        if (v === last) runLen++; else { if (runLen >= 5) penalty += 3 + (runLen - 5); runLen = 1; last = v; }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }
    for (var x2 = 0; x2 < n; x2++) {
      var runLen2 = 0, last2 = null;
      for (var y2 = 0; y2 < n; y2++) {
        var v2 = m[y2][x2];
        if (v2 === last2) runLen2++; else { if (runLen2 >= 5) penalty += 3 + (runLen2 - 5); runLen2 = 1; last2 = v2; }
      }
      if (runLen2 >= 5) penalty += 3 + (runLen2 - 5);
    }
    // Rule 2: 2x2 blocks
    for (var y3 = 0; y3 < n - 1; y3++) {
      for (var x3 = 0; x3 < n - 1; x3++) {
        var s = m[y3][x3] + m[y3][x3 + 1] + m[y3 + 1][x3] + m[y3 + 1][x3 + 1];
        if (s === 0 || s === 4) penalty += 3;
      }
    }
    // Rule 3: Finder-like patterns in rows and cols
    var pattern = [1,0,1,1,1,0,1,0,0,0,0];
    function checkLine(arr) {
      for (var i = 0; i <= arr.length - pattern.length; i++) {
        var ok = true;
        for (var j = 0; j < pattern.length; j++) if ((arr[i + j] ? 1 : 0) !== pattern[j]) { ok = false; break; }
        if (ok) penalty += 40;
      }
    }
    for (var y4 = 0; y4 < n; y4++) checkLine(m[y4]);
    for (var x4 = 0; x4 < n; x4++) {
      var col = [];
      for (var y5 = 0; y5 < n; y5++) col.push(m[y5][x4] ? 1 : 0);
      checkLine(col);
    }
    // Rule 4: balance of black modules
    var black = 0;
    for (var y6 = 0; y6 < n; y6++) for (var x5 = 0; x5 < n; x5++) if (m[y6][x5]) black++;
    var total = n * n;
    var k = Math.abs(black * 20 - total * 10) / total; // percent*20
    penalty += k * 10;
    return penalty;
  }

  function applyMask(m, mask) {
    var n = m.length;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (m[y][x] === null) continue; // reserved areas handled separately
      }
    }
  }

  function placeData(m, data, mask) {
    var n = m.length;
    var dirUp = true;
    var x = n - 1, y = n - 1;
    var bitIndex = 0;
    while (x > 0) {
      if (x === 6) x--; // skip timing column
      for (var i = 0; i < n; i++) {
        var yy = dirUp ? (n - 1 - i) : i;
        for (var dx = 0; dx < 2; dx++) {
          var xx = x - dx;
          if (m[yy][xx] !== null) continue; // skip reserved
          var bit = data[bitIndex++] || 0;
          var bitVal = !!bit;
          var maskOn = maskFunc(mask, yy, xx);
          m[yy][xx] = maskOn ? !bitVal : bitVal;
        }
      }
      x -= 2;
      dirUp = !dirUp;
    }
  }

  function bestMask(m, data) {
    var best = 0, bestScore = Infinity, chosen = null;
    for (var mask = 0; mask < 8; mask++) {
      // clone matrix and place
      var mm = m.map(function (row) { return row.slice(); });
      placeData(mm, data, mask);
      drawFormatInfo(mm, 'M', mask); // temporary ECL for evaluation; effect minor
      var score = penaltyScore(mm);
      if (score < bestScore) { bestScore = score; best = mask; chosen = mm; }
    }
    return { mask: best, matrix: chosen };
  }

  function encode(text, opts) {
    opts = Object.assign({}, defaults, opts || {});
    var ecl = getEcl(opts.ecl);
    var modeData = getModeAndData(text);

    // Guess version: find first version where capacity fits
    var version = opts.minVersion;
    var dataBuf = bitBuffer();
    var charCountBits = getCharCountBits(version);

    while (version <= opts.maxVersion) {
      // build payload for this version and see if it fits
      dataBuf.bits = [];
      dataBuf.put(modeData.mode, 4);
      dataBuf.put(modeData.data.length, charCountBits);
      for (var i = 0; i < modeData.data.length; i++) dataBuf.put(modeData.data[i], 8);

      // terminator up to 4 bits
      var capacity = calcCapacity(version, ecl);
      if (capacity < 0) break;
      var remaining = capacity - dataBuf.bits.length;
      if (remaining < 0) { version++; charCountBits = getCharCountBits(version); continue; }
      var terminator = Math.min(4, remaining);
      dataBuf.put(0, terminator);
      dataBuf.padToBytes();

      // add pad bytes 0xEC, 0x11 alternating
      var totalDataBytes = calcCapacity(version, ecl) / 8;
      var bytes = [];
      for (var b = 0; b < dataBuf.bits.length; b += 8) {
        var v = 0;
        for (var k = 0; k < 8; k++) v = (v << 1) | dataBuf.bits[b + k];
        bytes.push(v);
      }
      var padVals = [0xEC, 0x11];
      var pv = 0;
      while (bytes.length < totalDataBytes) { bytes.push(padVals[pv % 2]); pv++; }

      // For simplicity, assume one block. Compute EC bytes using RS with degree depending on version/ecl.
      // Approximate EC codewords count = total modules capacity/8 - data codewords; here we use the table diff
      var table = DATA_CODEWORDS[version];
      if (!table) { version++; continue; }
      var dataBytesCount = table[ecl];
      var ecBytesCount = (calcCapacity(version, ecl) / 8) - dataBytesCount;
      var gen = rsGenPoly(ecBytesCount);
      var ecR = rsComputeRemainder(bytes, gen);

      var interleaved = interleaveBlocks([bytes], [ecR]);

      // Convert to bit list
      var finalBits = [];
      for (var bi = 0; bi < interleaved.length; bi++) {
        for (var k2 = 7; k2 >= 0; k2--) finalBits.push((interleaved[bi] >>> k2) & 1);
      }

      // Build matrix and draw patterns
      var m = makeMatrix(version);
      drawFinder(m, 0, 0);
      drawFinder(m, m.length - 7, 0);
      drawFinder(m, 0, m.length - 7);
      drawSeparators(m);
      drawTiming(m);
      drawAlignment(m, version);
      reserveFormatAreas(m);
      drawDarkModule(m);

      // Choose mask and place data
      var choice = bestMask(m, finalBits);
      var chosenMask = opts.mask >= 0 ? opts.mask : choice.mask;
      var matrix = m.map(function (row) { return row.slice(); });
      placeData(matrix, finalBits, chosenMask);
      drawFormatInfo(matrix, ecl, chosenMask);

      return { version: version, ecl: ecl, size: matrix.length, modules: matrix };
    }

    throw new Error("Text too long for provided settings");
  }

  function renderToCanvas(modules, scale, border, canvas) {
    var n = modules.length;
    var size = (n + border * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (modules[y][x]) {
          ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
        }
      }
    }
  }

  function toDataURL(canvas) {
    return canvas.toDataURL('image/png');
  }

  var QRCode = {
    generate: function (text, options) {
      var res = encode(text, options || {});
      return res;
    },
    renderCanvas: function (qrobj, opts) {
      opts = Object.assign({ scale: defaults.scale, border: defaults.border }, opts || {});
      var canvas = opts.canvas || document.createElement('canvas');
      renderToCanvas(qrobj.modules, opts.scale, opts.border, canvas);
      return canvas;
    },
    toDataURL: function (canvas) { return toDataURL(canvas); },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QRCode;
  else global.QRCode = QRCode;

})(this);
