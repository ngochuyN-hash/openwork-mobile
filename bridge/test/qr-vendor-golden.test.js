// Ghim định dạng ASCII QR mà exe desktop decode (ParseDataModules trong
// desktop/src/PairingQrDialog.cs) — round 4 review 09/10, candidate 8.
//
// Vì sao: format này là kiến thức HAI NGÔN NGÔN KHÔNG GHIM — palette 4 ký tự
// (' ' = đen cả hai ô, ▀ = trên trắng dưới đen, ▄ = trên đen dưới trắng,
// █ = trắng cả hai), viền trên ▄, lề trái/phải █, hàng lẻ pad trắng. Ai đổi
// vendor hay sửa palette là C# decode ra null và khung QR trắng IM LẶNG — chỉ
// phát hiện được bằng cách cầm điện thoại lên chụp GUI. Test này_decode lại
// output y hệt C# nên một bên lệch là đỏ ở đây, không phải ở bàn của chủ máy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "../src/vendor/qrcode-terminal/index.js";

const render = (input) =>
  new Promise((resolve, reject) => {
    qrcode.generate(input, { small: true }, (out) => resolve(out));
  });

const GOLDEN_INPUT = "https://example.workers.dev/#p=GOLDEN1&m=pc-golden";

/** Decode y hệt ParseDataModules của C#: bỏ dòng viền đầu/cuối (NẾU có —
 * moduleCount lẻ thì vendor KHÔNG vẽ viền dưới, dòng cuối là data thật), bỏ
 * cột viền trái, mỗi ký tự nở thành 2 ô dọc. Trả grid[r][c] === true = ô ĐEN,
 * hoặc null khi gặp ký tự ngoài palette (đúng hành vi C# trả null). */
function decodeLikeCSharp(output) {
  const lines = output.split("\n").filter((l) => l.length > 0);
  const lastIsBorder = /^\u2580+$/.test(lines[lines.length - 1]);
  const dataLines = lastIsBorder ? lines.slice(1, lines.length - 1) : lines.slice(1);
  if (!dataLines.length) return null;
  const width = dataLines[0].length - 2; // trừ lề trái + phải
  if (width <= 0) return null;
  const grid = [];
  for (const line of dataLines) {
    const upper = [];
    const lower = [];
    for (let c = 1; c <= width; c++) {
      const ch = line[c];
      if (ch === " ") {
        upper.push(true);
        lower.push(true);
      } else if (ch === "\u2580") {
        upper.push(false);
        lower.push(true);
      } else if (ch === "\u2584") {
        upper.push(true);
        lower.push(false);
      } else if (ch === "\u2588") {
        upper.push(false);
        lower.push(false);
      } else {
        return null; // ký tự lạ — C# cũng bỏ tastin này
      }
    }
    grid.push(upper, lower);
  }
  return grid;
}

test("golden: render deterministic — cùng input ra byte-identical", async () => {
  assert.equal(await render(GOLDEN_INPUT), await render(GOLDEN_INPUT));
});

test("golden: chỉ dùng palette 4 ký tự; viền trên là hàng ▄; data rows có lề █", async () => {
  const out = await render(GOLDEN_INPUT);
  for (const ch of out) {
    assert.ok(" \u2580\u2584\u2588\n".includes(ch), `ký tự lạ ngoài palette: ${JSON.stringify(ch)}`);
  }
  const lines = out.split("\n").filter((l) => l.length > 0);
  assert.match(lines[0], /^\u2584+$/, "dòng đầu phải là viền ▄ trọn hàng");
  const dataLines = lines.slice(1, lines.length - 1);
  for (const line of dataLines) {
    assert.ok(line.startsWith("\u2588") && line.endsWith("\u2588"), `data row mất lề █: ${JSON.stringify(line)}`);
  }
});

test("golden: decode y hệt C# ra grid vuông có finder pattern 7x7 ở 3 góc", async () => {
  const out = await render(GOLDEN_INPUT);
  const grid = decodeLikeCSharp(out);
  assert.ok(grid, "decode phải thành công — null nghĩa là format đã lệch với C#");
  const n = grid.length;
  assert.ok(n >= 21 && n % 2 === 0, `grid hợp lệ tối thiểu 21x21 (thật ra ${n} hàng)`);

  // Finder top-left: vành đen vòng 7x7, ruột 3x3 đen, giữa vành-ruột trắng.
  for (let i = 0; i < 7; i++) {
    assert.equal(grid[0][i], true, `finder top edge [0][${i}]`);
    assert.equal(grid[6][i], true, `finder bottom edge [6][${i}]`);
    assert.equal(grid[i][0], true, `finder left edge [${i}][0]`);
    assert.equal(grid[i][6], true, `finder right edge [${i}][6]`);
  }
  for (let r = 2; r <= 4; r++) {
    for (let c = 2; c <= 4; c++) {
      assert.equal(grid[r][c], true, `finder core [${r}][${c}]`);
    }
  }
  assert.equal(grid[1][1], false, "vành trắng giữa vành và ruột");
  assert.equal(grid[3][1], false);

  // Finder top-right + bottom-left: cùng luật, đối xứng qua góc. Lưu ý số
  // HÀNG grid có thể thừa 1 hàng pad trắng (vendor đệm khi moduleCount lẻ) —
  // toạ độ module thật theo số CỘT.
  const mCols = grid[0].length;
  for (let i = 0; i < 7; i++) {
    assert.equal(grid[0][mCols - 1 - i], true, "finder TR top edge");
    assert.equal(grid[6][mCols - 1 - i], true, "finder TR bottom edge");
    assert.equal(grid[i][mCols - 7], true, "finder TR left edge");
    assert.equal(grid[i][mCols - 1], true, "finder TR right edge");
    assert.equal(grid[mCols - 7][i], true, "finder BL top edge");
    assert.equal(grid[mCols - 1][i], true, "finder BL bottom edge");
    assert.equal(grid[mCols - 7 + i][0], true, "finder BL left edge");
    assert.equal(grid[mCols - 7 + i][6], true, "finder BL right edge");
  }
});

test("chéo ngôn ngữ: C# ParseDataModules vẫn nhận đúng palette của vendor", () => {
  // Ai đổi một bên (vendor palette hay switch case trong C#) thì test này đỏ —
  // đúng cái "hai ngôn ngữ không thể drift" mà host-contract làm cho kiến thức host.
  const cs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "src", "PairingQrDialog.cs"),
    "utf8"
  );
  assert.ok(cs.includes("BLACK_ALL"), "C# mất chú giải BLACK_ALL (' ' = đen)");
  assert.ok(cs.includes("\\u2580"), "C# mất WHITE_BLACK (▀ = trên trắng dưới đen)");
  assert.ok(cs.includes("\\u2584"), "C# mất BLACK_WHITE (▄ = trên đen dưới trắng)");
  const vendor = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "vendor", "qrcode-terminal", "index.js"),
    "utf8"
  );
  for (const ch of ["\\u2588", "\\u2580", "\\u2584"]) {
    assert.ok(vendor.includes(ch), `vendor mất ký tự palette ${ch}`);
  }
});
