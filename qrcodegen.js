(function (global) {
  "use strict";

  // ---------- Error correction level constants ----------
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };

  // ---------- ECC and alignment tables (simplified for demonstration) ----------
  var ECC_CODEWORDS_PER_BLOCK = [
    /* Fill with actual values for all versions */
    0, /* placeholder */
  ];

  var ALIGNMENT_PATTERN_LOCATIONS = [
    [], /* Version 1 */
    [6, 18], /* Version 2 */
    [6, 22], /* Version 3 */
    // Fill in full table for versions 1–40
  ];

  function getSize(version) { return 17 + version * 4; }

  // ---------- Reed–Solomon setup ----------
  var GF256_EXP = new Array(512), GF256_LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF256_EXP[i] = x;
      GF256_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) GF256_EXP[j] = GF256_EXP[j - 255];
  })();

  function rsMul(x, y) { if (x === 0 || y === 0) return 0; return GF256_EXP[(GF256_LOG[x] + GF256_LOG[y]) % 255]; }
  function rsGenPoly(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      poly.push(0);
      for (var j = poly.length - 1; j > 0; j--)
        poly[j] ^= rsMul(poly[j - 1], GF256_EXP[i]);
    }
    return poly;
  }
  function rsCompute(msg, gen) {
    var res = new Array(gen.length - 1).fill(0);
    for (var i = 0; i < msg.length; i++) {
      var factor = msg[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < res.length; j++)
        res[j] ^= rsMul(gen[j], factor);
    }
    return res;
  }

  // ---------- Encoding helpers ----------
  var ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

  function encodeSegments(text) {
    // Detect numeric / alphanumeric / byte mode
    if (/^\d+$/.test(text)) {
      // Numeric mode
      var bytes = [];
      for (var i = 0; i < text.length; i += 3) {
        var chunk = text.substr(i, 3);
        var val = parseInt(chunk, 10);
        if (chunk.length === 3) bytes.push(val >> 4, ((val & 15) << 4));
        else if (chunk.length === 2) bytes.push(val >> 2, ((val & 3) << 6));
        else bytes.push(val);
      }
      return { mode: 1, data: bytes };
    } else if (/^[0-9A-Z $%*+\-./:]+$/.test(text)) {
      // Alphanumeric mode
      var bytes = [];
      for (var i = 0; i < text.length; i += 2) {
        if (i + 1 < text.length) {
          var val = ALPHANUMERIC_CHARS.indexOf(text[i]) * 45 + ALPHANUMERIC_CHARS.indexOf(text[i + 1]);
          bytes.push(val >> 8, val & 0xFF);
        } else {
          bytes.push(ALPHANUMERIC_CHARS.indexOf(text[i]));
        }
      }
      return { mode: 2, data: bytes };
    } else {
      // Byte mode
      var bytes = [];
      for (var i = 0; i < text.length; i++)
        bytes.push(text.charCodeAt(i) & 0xFF);
      return { mode: 4, data: bytes };
    }
  }

  function toBitArray(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i++)
      for (var b = 7; b >= 0; b--) out.push((bytes[i] >>> b) & 1);
    return out;
  }

  // ---------- Matrix creation ----------
  function buildMatrix(version) {
    var size = getSize(version);
    var m = new Array(size);
    for (var y = 0; y < size; y++) m[y] = new Array(size).fill(null);
    return m;
  }

  // ---------- Fixed patterns ----------
  function drawFinder(m, x, y) {
    for (let dy = 0; dy < 7; dy++)
      for (let dx = 0; dx < 7; dx++) {
        const xx = x + dx, yy = y + dy;
        m[yy][xx] =
          dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
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
    for (var i = 8; i < n - 8; i++) { m[6][i] = (i % 2 === 0); m[i][6] = (i % 2 === 0); }
  }

  function drawAlignment(m, version) {
    var pos = ALIGNMENT_PATTERN_LOCATIONS[version];
    for (var i = 0; i < pos.length; i++)
      for (var j = 0; j < pos.length; j++) {
        var x = pos[i], y = pos[j];
        if (m[y][x] !== null) continue;
        for (var dy = -2; dy <= 2; dy++)
          for (var dx = -2; dx <= 2; dx++) {
            var xx = x + dx, yy = y + dy;
            var dist = Math.max(Math.abs(dx), Math.abs(dy));
            m[yy][xx] = (dist === 0 || dist === 2);
          }
      }
  }

  function reserveFormat(m) {
    var n = m.length;
    for (var i = 0; i < 9; i++) if (m[8][i] === null) m[8][i] = false;
    for (var i2 = 0; i2 < 8; i2++) if (m[i2][8] === null) m[i2][8] = false;
    for (var i3 = n - 8; i3 < n; i3++) if (m[8][i3] === null) m[8][i3] = false;
    for (var i4 = n - 7; i4 < n; i4++) if (m[i4][8] === null) m[i4][8] = false;
  }

  function drawDark(m, version) { var row = 4 * version + 9; m[row][8] = true; }

  // ---------- BCH and format info ----------
  function BCH(value, poly) {
    let msb = poly.toString(2).length - 1;
    value <<= msb;
    while ((value >> msb) >= (1 << msb)) {
      let shift = Math.floor(Math.log2(value)) - msb;
      value ^= poly << shift;
    }
    return value;
  }

  function drawFormat(m, ecl, mask) {
    const n = m.length;
    const eclBits = { L: 1, M: 0, Q: 3, H: 2 }[ecl];
    const data = (eclBits << 3) | mask;
    const rem = BCH(data, 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) m[8][i] = ((bits >> i) & 1) !== 0;
    m[8][7] = ((bits >> 6) & 1) !== 0;
    m[8][8] = ((bits >> 7) & 1) !== 0;
    m[7][8] = ((bits >> 8) & 1) !== 0;
    for (let i = 9; i < 15; i++) m[14 - i][8] = ((bits >> i) & 1) !== 0;

    for (let i = 0; i < 8; i++) m[n - 1 - i][8] = ((bits >> i) & 1) !== 0;
    for (let i = 0; i < 7; i++) m[8][n - 1 - i] = ((bits >> (i + 8)) & 1) !== 0;
  }

  // ---------- Masking ----------
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
      default: return false;
    }
  }

  function placeData(m, data, mask) {
    var n = m.length, dirUp = true, x = n - 1, bitIndex = 0;
    while (x > 0) {
      if (x === 6) x--;
      for (var i = 0; i < n; i++) {
        var y = dirUp ? (n - 1 - i) : i;
        for (var dx = 0; dx < 2; dx++) {
          var xx = x - dx;
          if (m[y][xx] !== null) continue;
          var bit = data[bitIndex++] || 0;
          var masked = maskFunc(mask, y, xx) ? !bit : !!bit;
          m[y][xx] = masked;
        }
      }
      x -= 2; dirUp = !dirUp;
    }
  }

  // ---------- Penalty scoring ----------
  function penalty(m) {
    var n = m.length, p = 0;
    for (var y = 0; y < n; y++) {
      var run = 1;
      for (var x = 1; x < n; x++) {
        if (m[y][x] === m[y][x - 1]) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
    for (var x2 = 0; x2 < n; x2++) {
      var run2 = 1;
      for (var y2 = 1; y2 < n; y2++) {
        if (m[y2][x2] === m[y2 - 1][x2]) run2++;
        else { if (run2 >= 5) p += 3 + (run2 - 5); run2 = 1; }
      }
      if (run2 >= 5) p += 3 + (run2 - 5);
    }
    for (var y3 = 0; y3 < n - 1; y3++)
      for (var x3 = 0; x3 < n - 1; x3++) {
        var s = m[y3][x3] + m[y3][x3 + 1] + m[y3 + 1][x3] + m[y3 + 1][x3 + 1];
        if (s === 0 || s === 4) p += 3;
      }
    var pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    function checkLine(arr) {
      for (var i = 0; i <= arr.length - pat.length; i++) {
        var ok = true;
        for (var j = 0; j < pat.length; j++) {
          if ((arr[i + j] ? 1 : 0) !== pat[j]) { ok = false; break; }
        }
        if (ok) p += 40;
      }
    }
    for (var y4 = 0; y4 < n; y4++) checkLine(m[y4]);
    for (var x4 = 0; x4 < n; x4++) {
      var col = [];
      for (var y5 = 0; y5 < n; y5++) col.push(m[y5][x4] ? 1 : 0);
      checkLine(col);
    }
    var black = 0;
    for (var y6 = 0; y6 < n; y6++)
      for (var x5 = 0; x5 < n; x5++)
        if (m[y6][x5]) black++;
    var total = n * n;
    var k = Math.abs(black * 20 - total * 10) / total;
    p += k * 10;
    return p;
  }

  // ---------- Encoding and rendering ----------
  function encode(text, version, ecl) {
    var seg = encodeSegments(text);
    var data = seg.data;
    var m = buildMatrix(version);
    drawFinder(m, 0, 0);
    drawFinder(m, m.length - 7, 0);
    drawFinder(m, 0, m.length - 7);
    drawSeparators(m);
    drawTiming(m);
    drawAlignment(m, version);
    reserveFormat(m);
    drawDark(m, version);

    var bits = toBitArray(data);
    var bestMask = 0, bestScore = 1e9, bestM = null;
    for (var mask = 0; mask < 8; mask++) {
      var testM = JSON.parse(JSON.stringify(m));
      placeData(testM, bits, mask);
      drawFormat(testM, ecl, mask);
      var score = penalty(testM);
      if (score < bestScore) { bestScore = score; bestMask = mask; bestM = testM; }
    }
    return bestM;
  }

  function renderToCanvas(m, cellSize) {
    var n = m.length, canvas = document.createElement("canvas");
    canvas.width = canvas.height = n * cellSize;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (var y = 0; y < n; y++)
      for (var x = 0; x < n; x++)
        if (m[y][x]) ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    return canvas;
  }

  // ---------- Auto-version selection ----------
  global.QRCode = {
    generate: function (text, version, ecl) {
      const MAX_VERSION = 40;
      ecl = ecl || "M";
      for (let v = version || 1; v <= MAX_VERSION; v++) {
        try { return encode(text, v, ecl); } catch (e) { continue; }
      }
      throw new Error("Data too long to encode in QR code");
    },
    renderCanvas: renderToCanvas
  };

})(this);
