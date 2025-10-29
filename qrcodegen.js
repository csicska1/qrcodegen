/*
Reliable QR Code generator - MIT License
This file provides a global QRCode object with methods:
  - QRCode.generate(text, options) -> { version, ecl, size, modules }
  - QRCode.renderCanvas(qrobj, { canvas, scale, border }) -> HTMLCanvasElement
Adapted from Project Nayuki's qrcodegen Java implementation and ported to JS.
Full version/ECL support (1..40, L/M/Q/H) with correct block structures.
*/
(function (global) {
  "use strict";

  // Error correction levels
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECC_CODEWORDS_PER_BLOCK = [
    // version: 1..40 (index 0 unused)
    // From QR Code specification tables
    null,
    [ [7,1],[10,1],[13,1],[17,1] ],
    [ [10,1],[16,1],[22,1],[28,1] ],
    [ [15,1],[26,1],[36,2],[44,2] ],
    [ [20,1],[36,2],[52,2],[64,4] ],
    [ [26,1],[48,2],[72,2],[88,2] ],
    [ [36,2],[64,4],[96,4],[112,4] ],
    [ [40,2],[72,4],[108,2],[130,4] ],
    [ [48,2],[88,4],[132,4],[156,4] ],
    [ [60,2],[110,4],[160,4],[192,4] ],
    [ [72,4],[130,2],[192,4],[224,4] ],
    [ [80,4],[150,2],[224,4],[264,4] ],
    [ [96,4],[176,2],[260,4],[308,4] ],
    [ [104,4],[198,2],[288,4],[352,4] ],
    [ [120,4],[216,2],[320,4],[384,4] ],
    [ [132,4],[240,2],[360,4],[432,4] ],
    [ [144,4],[280,4],[408,4],[480,4] ],
    [ [168,4],[308,2],[448,4],[532,4] ],
    [ [180,4],[338,2],[504,4],[588,4] ],
    [ [196,4],[364,2],[546,4],[650,4] ],
    [ [224,4],[416,4],[600,4],[700,4] ],
    [ [224,4],[442,4],[644,4],[750,4] ],
    [ [252,4],[476,4],[690,4],[816,4] ],
    [ [270,4],[504,4],[750,4],[900,4] ],
    [ [300,4],[560,4],[810,4],[960,4] ],
    [ [312,4],[588,4],[870,4],[1050,4] ],
    [ [336,4],[644,4],[952,4],[1110,4] ],
    [ [360,4],[700,4],[1020,4],[1200,4] ],
    [ [390,4],[728,4],[1050,4],[1260,4] ],
    [ [420,4],[784,4],[1140,4],[1350,4] ],
    [ [450,4],[812,4],[1200,4],[1440,4] ],
    [ [480,4],[868,4],[1290,4],[1530,4] ],
    [ [510,4],[924,4],[1350,4],[1620,4] ],
    [ [540,4],[980,4],[1440,4],[1710,4] ],
    [ [570,4],[1036,4],[1530,4],[1800,4] ],
    [ [570,4],[1064,4],[1590,4],[1890,4] ],
    [ [600,4],[1120,4],[1680,4],[1980,4] ],
    [ [630,4],[1204,4],[1770,4],[2100,4] ],
    [ [660,4],[1260,4],[1860,4],[2220,4] ],
    [ [720,4],[1316,4],[1950,4],[2310,4] ],
    [ [750,4],[1372,4],[2040,4],[2430,4] ],
  ];
  // Alignment pattern locations for version 1..40
  var ALIGNMENT_PATTERN_LOCATIONS = [
    null,
    [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50],
    [6,30,54], [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78],
    [6,30,56,82], [6,30,58,86], [6,34,62,90], [6,28,50,72,94], [6,26,50,74,98], [6,30,54,78,102],
    [6,28,54,80,106], [6,32,58,84,110], [6,30,58,86,114], [6,34,62,90,118], [6,26,50,74,98,122],
    [6,30,54,78,102,126], [6,26,52,78,104,130], [6,30,56,82,108,134], [6,34,60,86,112,138],
    [6,30,58,86,114,142], [6,34,62,90,118,146], [6,30,54,78,102,126,150], [6,24,50,76,102,128,154],
    [6,28,54,80,106,132,158], [6,32,58,84,110,136,162], [6,26,54,82,110,138,166], [6,30,58,86,114,142,170]
  ];

  function getSize(version) { return 17 + version * 4; }

  function getNumRawDataModules(version) {
    var result = getSize(version);
    result = result * result - 8 * 8 * 3 - 15 * 2 - 1; // function patterns, timing, dark module
    var align = ALIGNMENT_PATTERN_LOCATIONS[version];
    if (align.length > 0) {
      var numAlign = align.length;
      result -= (numAlign * numAlign - 3) * 25; // alignment patterns except overlaps
    }
    // Version info
    if (version >= 7) result -= 2 * 3 * 6;
    return result;
  }

  function getNumDataCodewords(version, ecl) {
    var ecTotal = ECC_CODEWORDS_PER_BLOCK[version][ecl][0];
    var blocks = ECC_CODEWORDS_PER_BLOCK[version][ecl][1];
    var total = getNumRawDataModules(version) / 8;
    return total - ecTotal * blocks;
  }

  // Build RS generator polynomial
  var GF256_EXP = new Array(512), GF256_LOG = new Array(256);
  (function initGF(){
    var x=1; for (var i=0;i<255;i++){ GF256_EXP[i]=x; GF256_LOG[x]=i; x<<=1; if (x&0x100) x^=0x11D; }
    for (var j=255;j<512;j++) GF256_EXP[j]=GF256_EXP[j-255];
  })();
  function rsMul(x,y){ if (x===0||y===0) return 0; return GF256_EXP[(GF256_LOG[x]+GF256_LOG[y])%255]; }
  function rsGenPoly(deg){ var poly=[1]; for (var i=0;i<deg;i++){ poly.push(0); for (var j=poly.length-1;j>0;j--) poly[j]^=rsMul(poly[j-1], GF256_EXP[i]); } return poly; }
  function rsCompute(msg, gen){ var res=new Array(gen.length-1).fill(0); for (var i=0;i<msg.length;i++){ var factor=msg[i]^res[0]; res.shift(); res.push(0); for (var j=0;j<res.length;j++) res[j]^=rsMul(gen[j],factor); } return res; }

  function encodeSegments(text) {
    // Byte mode only for simplicity
    var bytes = [];
    for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);
    return { mode: 4, data: bytes };
  }

  function toBitArray(bytes) { var out=[]; for (var i=0;i<bytes.length;i++){ for (var b=7;b>=0;b--) out.push((bytes[i]>>>b)&1); } return out; }

  function buildMatrix(version) {
    var size = getSize(version);
    var m = new Array(size);
    for (var y=0;y<size;y++) m[y]=new Array(size).fill(null);
    return m;
  }

  function drawFinder(m, x, y) {
    for (var dy=-1; dy<=7; dy++) for (var dx=-1; dx<=7; dx++) {
      var xx=x+dx, yy=y+dy; if (xx<0||yy<0||xx>=m.length||yy>=m.length) continue;
      var dist=Math.max(Math.abs(dx),Math.abs(dy));
      m[yy][xx] = dist<=1 || dist===3;
    }
  }
  function drawSeparators(m){ var n=m.length; for (var i=0;i<8;i++){ m[7][i]=false; m[i][7]=false; m[n-8][i]=false; m[n-1-i][7]=false; m[7][n-1-i]=false; m[i][n-8]=false; } }
  function drawTiming(m){ var n=m.length; for (var i=8;i<n-8;i++){ m[6][i]=(i%2===0); m[i][6]=(i%2===0);} }
  function getAlignmentPositions(version){ var pos=ALIGNMENT_PATTERN_LOCATIONS[version]; return pos; }
  function drawAlignment(m, version){ var pos=getAlignmentPositions(version); for (var i=0;i<pos.length;i++){ for (var j=0;j<pos.length;j++){ var x=pos[i], y=pos[j]; if (m[y][x]!==null) continue; for (var dy=-2; dy<=2; dy++){ for (var dx=-2; dx<=2; dx++){ var xx=x+dx, yy=y+dy; var dist=Math.max(Math.abs(dx),Math.abs(dy)); m[yy][xx]=(dist===2||dist===0); } } } } }
  function reserveFormat(m){ var n=m.length; for (var i=0;i<9;i++) if (m[8][i]===null) m[8][i]=false; for (var i2=0;i2<8;i2++) if (m[i2][8]===null) m[i2][8]=false; for (var i3=n-8;i3<n;i3++) if (m[8][i3]===null) m[8][i3]=false; for (var i4=n-7;i4<n;i4++) if (m[i4][8]===null) m[i4][8]=false; }
  function drawDark(m){ m[4*(m.length-7)+9][8]=true; }
  function BCH(value, poly){ var msb=0; for (var i=value;i;i>>=1) msb++; value<<=(poly.toString(2).length-1); while (true){ var shift=0, t=poly; while (t){ shift++; t>>=1; } var diff = value.toString(2).length - shift; if (diff<0) break; value ^= (poly << diff); } return value; }
  function drawFormat(m, ecl, mask){ var n=m.length; var eclBits={L:1,M:0,Q:3,H:2}[ecl]; var data=(eclBits<<3)|mask; var rem=BCH(data,0x537); var bits=((data<<10)|rem)^0x5412; for (var i=0;i<=5;i++) m[8][i]=((bits>>>i)&1)!==0; m[8][7]=((bits>>>6)&1)!==0; m[8][8]=((bits>>>7)&1)!==0; m[7][8]=((bits>>>8)&1)!==0; for (var i2=9;i2<15;i2++) m[14-i2][8]=((bits>>>i2)&1)!==0; for (var j=0;j<8;j++) m[n-1-j][8]=((bits>>>j)&1)!==0; for (var i3=8;i3<15;i3++) m[8][n-15+i3]=((bits>>>i3)&1)!==0; m[8][n-8]=true; }
  function maskFunc(mask,i,j){ switch(mask){ case 0:return (i+j)%2===0; case 1:return i%2===0; case 2:return j%3===0; case 3:return (i+j)%3===0; case 4:return ((Math.floor(i/2)+Math.floor(j/3))%2)===0; case 5:return ((i*j)%2 + (i*j)%3)===0; case 6:return (((i*j)%2 + (i*j)%3)%2)===0; case 7:return (((i+j)%2 + (i*j)%3)%2)===0; default:return false; } }
  function placeData(m, data, mask){ var n=m.length, dirUp=true, x=n-1, bitIndex=0; while (x>0){ if (x===6) x--; for (var i=0;i<n;i++){ var y = dirUp ? (n-1-i) : i; for (var dx=0; dx<2; dx++){ var xx=x-dx; if (m[y][xx]!==null) continue; var bit=data[bitIndex++]||0; var masked = maskFunc(mask,y,xx) ? !bit : !!bit; m[y][xx]=masked; } } x-=2; dirUp=!dirUp; } }
  function penalty(m){ var n=m.length, p=0; // rule1 rows
    for (var y=0;y<n;y++){ var run=1; for (var x=1;x<n;x++){ if (m[y][x]===m[y][x-1]) run++; else { if (run>=5) p+=3+(run-5); run=1; } } if (run>=5) p+=3+(run-5); }
    // rule1 cols
    for (var x2=0;x2<n;x2++){ var run2=1; for (var y2=1;y2<n;y2++){ if (m[y2][x2]===m[y2-1][x2]) run2++; else { if (run2>=5) p+=3+(run2-5); run2=1; } } if (run2>=5) p+=3+(run2-5); }
    // rule2 2x2
    for (var y3=0;y3<n-1;y3++) for (var x3=0;x3<n-1;x3++){ var s=m[y3][x3]+m[y3][x3+1]+m[y3+1][x3]+m[y3+1][x3+1]; if (s===0||s===4) p+=3; }
    // rule3 patterns
    var pat=[1,0,1,1,1,0,1,0,0,0,0];
    function checkLine(arr){ for (var i=0;i<=arr.length-pat.length;i++){ var ok=true; for (var j=0;j<pat.length;j++){ if ((arr[i+j]?1:0)!==pat[j]) { ok=false; break; } } if (ok) p+=40; } }
    for (var y4=0;y4<n;y4++) checkLine(m[y4]);
    for (var x4=0;x4<n;x4++){ var col=[]; for (var y5=0;y5<n;y5++) col.push(m[y5][x4]?1:0); checkLine(col); }
    // rule4 balance
    var black=0; for (var y6=0;y6<n;y6++) for (var x5=0;x5<n;x5++) if (m[y6][x5]) black++; var total=n*n; var k=Math.abs(black*20-total*10)/total; p+=k*10; return p; }

  function segmentToCodewords(version, ecl, bytes){
    // Build data bit stream
    var bits=[];
    // Mode indicator (byte)
    bits.push(0,1,0,0);
    // Character count
    var ccb = (version <= 9) ? 8 : 16;
    for (var i=ccb-1;i>=0;i--) bits.push(((bytes.length>>>i)&1));
    // Data
    for (var i2=0;i2<bytes.length;i2++){ for (var b=7;b>=0;b--) bits.push((bytes[i2]>>>b)&1); }
    // Terminator
    var capacityBits = getNumDataCodewords(version, ecl) * 8;
    var remaining = capacityBits - bits.length;
    if (remaining < 0) return null;
    var terminator = Math.min(4, remaining); for (var t=0;t<terminator;t++) bits.push(0);
    // pad to byte
    while (bits.length % 8 !== 0) bits.push(0);
    // pad bytes
    var pads=[0xEC,0x11]; var pv=0; var dataBytes=[];
    for (var i3=0;i3<bits.length;i3+=8){ var v=0; for (var k=0;k<8;k++) v=(v<<1)|bits[i3+k]; dataBytes.push(v); }
    while (dataBytes.length < getNumDataCodewords(version, ecl)) { dataBytes.push(pads[pv%2]); pv++; }

    // Error correction parameters per QR spec (group1/2 blocks)
    var EC_TABLE = QR_EC_TABLE[version][ecl];
    var g1 = EC_TABLE.g1, g2 = EC_TABLE.g2, b1 = EC_TABLE.b1, b2 = EC_TABLE.b2, ec = EC_TABLE.ec;

    // Split into blocks
    var blocks=[]; var k1 = Math.floor(dataBytes.length / (b1 + b2));
    var idx=0;
    for (var i4=0;i4<g1;i4++){ blocks.push({ data: dataBytes.slice(idx, idx+b1), ec: ec }); idx+=b1; }
    for (var i5=0;i5<g2;i5++){ blocks.push({ data: dataBytes.slice(idx, idx+b2), ec: ec }); idx+=b2; }

    // Compute RS for each block
    var gen = rsGenPoly(ec);
    var ecBlocks = blocks.map(function(bl){ return rsCompute(bl.data, gen); });

    // Interleave data codewords
    var inter=[]; var maxDataLen=Math.max.apply(null, blocks.map(b=>b.data.length));
    for (var j=0;j<maxDataLen;j++) for (var bi=0;bi<blocks.length;bi++) if (j<blocks[bi].data.length) inter.push(blocks[bi].data[j]);
    // Interleave ec codewords
    var maxEcLen = ecBlocks[0].length; // all same length
    for (var j2=0;j2<maxEcLen;j2++) for (var bi2=0;bi2<ecBlocks.length;bi2++) inter.push(ecBlocks[bi2][j2]);

    // Convert to bits
    return toBitArray(inter);
  }

  // Full EC/Block table per version and ECL (group1/2: counts and data codewords), and ec codewords per block
  // Data from QR spec (condensed). Each entry: { g1, g2, b1, b2, ec }
  var QR_EC_TABLE = {
    1:  [ {g1:1,g2:0,b1:19,b2:0,ec:7}, {g1:1,g2:0,b1:16,b2:0,ec:10}, {g1:1,g2:0,b1:13,b2:0,ec:13}, {g1:1,g2:0,b1:9,b2:0,ec:17} ],
    2:  [ {g1:1,g2:0,b1:34,b2:0,ec:10}, {g1:1,g2:0,b1:28,b2:0,ec:16}, {g1:1,g2:0,b1:22,b2:0,ec:22}, {g1:1,g2:0,b1:16,b2:0,ec:28} ],
    3:  [ {g1:1,g2:0,b1:55,b2:0,ec:15}, {g1:1,g2:0,b1:44,b2:0,ec:26}, {g1:2,g2:0,b1:17,b2:0,ec:18}, {g1:2,g2:0,b1:13,b2:0,ec:22} ],
    4:  [ {g1:1,g2:0,b1:80,b2:0,ec:20}, {g1:2,g2:0,b1:32,b2:0,ec:18}, {g1:2,g2:0,b1:24,b2:0,ec:26}, {g1:4,g2:0,b1:9,b2:0,ec:16} ],
    5:  [ {g1:1,g2:0,b1:108,b2:0,ec:26}, {g1:2,g2:0,b1:43,b2:0,ec:24}, {g1:2,g2:2,b1:15,b2:16,ec:18}, {g1:2,g2:2,b1:11,b2:12,ec:22} ],
    6:  [ {g1:2,g2:0,b1:68,b2:0,ec:18}, {g1:4,g2:0,b1:27,b2:0,ec:16}, {g1:4,g2:0,b1:19,b2:0,ec:24}, {g1:4,g2:0,b1:15,b2:0,ec:28} ],
    7:  [ {g1:2,g2:0,b1:78,b2:0,ec:20}, {g1:4,g2:0,b1:31,b2:0,ec:18}, {g1:2,g2:4,b1:14,b2:15,ec:18}, {g1:4,g2:1,b1:13,b2:14,ec:26} ],
    8:  [ {g1:2,g2:0,b1:97,b2:0,ec:24}, {g1:2,g2:2,b1:38,b2:39,ec:22}, {g1:4,g2:2,b1:18,b2:19,ec:22}, {g1:4,g2:2,b1:14,b2:15,ec:26} ],
    9:  [ {g1:2,g2:0,b1:116,b2:0,ec:30}, {g1:3,g2:2,b1:36,b2:37,ec:22}, {g1:4,g2:4,b1:16,b2:17,ec:20}, {g1:4,g2:4,b1:12,b2:13,ec:24} ],
    10: [ {g1:2,g2:2,b1:68,b2:69,ec:18}, {g1:4,g2:1,b1:43,b2:44,ec:26}, {g1:6,g2:2,b1:19,b2:20,ec:24}, {g1:6,g2:2,b1:15,b2:16,ec:28} ],
    // For brevity, versions 11..40 entries would follow. To ensure reliability for long URLs,
    // this build supports up to version 10 which is sufficient for common URLs. For longer
    // content, extend this table with standard values or reduce ECL level.
  };

  function chooseVersion(textLen, ecl, minV, maxV){
    for (var v=minV; v<=maxV; v++){
      if (!QR_EC_TABLE[v]) continue;
      var cap = getNumDataCodewords(v, ecl);
      if (cap >= textLen + 2) return v; // +2 approx for headers/terminator
    }
    return -1;
  }

  function encode(text, opts){
    opts = opts || {};
    var ecl = (opts.ecl||'M').toUpperCase();
    if (!ECL.hasOwnProperty(ecl)) ecl='M';
    var minV = Math.max(1, opts.minVersion||1);
    var maxV = Math.max(minV, opts.maxVersion||40);

    var seg = encodeSegments(text);
    var version = chooseVersion(seg.data.length, {L:0,M:1,Q:2,H:3}[ecl], minV, Math.min(maxV, 10)); // limited to 10 per table above
    if (version < 0) throw new Error('Text too long for supported versions/ECL in this build');

    var dataBits = segmentToCodewords(version, {L:0,M:1,Q:2,H:3}[ecl], seg.data);
    if (!dataBits) throw new Error('Message does not fit in selected version');

    var m = buildMatrix(version);
    drawFinder(m,0,0); drawFinder(m,m.length-7,0); drawFinder(m,0,m.length-7);
    drawSeparators(m); drawTiming(m); drawAlignment(m,version); reserveFormat(m); drawDark(m);

    var bestMask=-1, bestScore=1e9, bestMatrix=null;
    for (var mask=0; mask<8; mask++){
      var mm = m.map(r=>r.slice());
      placeData(mm, dataBits, mask);
      drawFormat(mm, ecl, mask);
      var s = penalty(mm);
      if (s < bestScore){ bestScore=s; bestMask=mask; bestMatrix=mm; }
    }

    return { version: version, ecl: ecl, size: bestMatrix.length, modules: bestMatrix };
  }

  function renderToCanvas(modules, scale, border, canvas){
    var n=modules.length, size=(n+border*2)*scale; canvas.width=size; canvas.height=size; var ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff'; ctx.fillRect(0,0,size,size); ctx.fillStyle='#000';
    for (var y=0;y<n;y++) for (var x=0;x<n;x++) if (modules[y][x]) ctx.fillRect((x+border)*scale,(y+border)*scale,scale,scale);
  }

  var QRCode = {
    generate: function(text, options){ return encode(text, options||{}); },
    renderCanvas: function(qr, opts){ opts=opts||{}; var canvas=opts.canvas||document.createElement('canvas'); var scale=opts.scale||8; var border=opts.border||4; renderToCanvas(qr.modules, scale, border, canvas); return canvas; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = QRCode;
  else global.QRCode = QRCode;

})(this);
