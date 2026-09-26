// Tiny ANSI helpers + a colored "text box" renderer. No screen takeover:
// everything is printed inline into the normal terminal scrollback, so native
// selection / copy keeps working exactly as if the text had been typed.

const ESC = "\x1b[";
const wrap = (code) => (s) => `${ESC}${code}m${s}${ESC}0m`;

export const color = {
  reset: `${ESC}0m`,
  bold: wrap(1),
  dim: wrap(2),
  cyan: wrap(36),
  green: wrap(32),
  red: wrap(31),
  yellow: wrap(33),
  gray: wrap(90),
  magenta: wrap(35),
  blue: wrap(34),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s) => s.replace(ANSI_RE, "").length;

// Strip ALL escape/control sequences (SGR colors, cursor moves, etc.). The box
// body comes from untrusted model output; a stray or unclosed color code there
// would otherwise bleed into the border and, worse, leak past the box into the
// next shell prompt (giving you a wrong-colored PS1).
const CTRL_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
export const stripAnsi = (s) => s.replace(CTRL_RE, "");

// Word-wrap plain text (no embedded ANSI) to a column width.
export function wrapText(text, width) {
  const out = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of rawLine.split(/(\s+)/)) {
      if (visibleWidth(line + word) > width && line !== "") {
        out.push(line.replace(/\s+$/, ""));
        line = word.replace(/^\s+/, "");
      } else {
        line += word;
      }
    }
    if (line.trim() !== "" || out.length === 0) out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

const pad = (s, w) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

// Render a colored box around `body`. Returns a string ready to print.
export function box(title, body, tint = color.cyan, termWidth = 80) {
  const inner = Math.min(Math.max(20, termWidth - 4), 96);
  // Neutralize any escape sequences from the (untrusted) body so nothing can
  // bleed into the border or the following shell prompt.
  const lines = wrapText(stripAnsi(body), inner);
  const dash = "─".repeat(Math.max(0, inner - title.length - 1));
  // Build the top border in one tint span. Re-apply `tint` after the bold
  // title, because color.bold(...) ends with a full reset (\x1b[0m) that would
  // otherwise strip the border color for the rest of the line.
  const openTint = tint("").slice(0, -`${ESC}0m`.length);
  const top =
    openTint +
    `╭─ ${color.bold(title)}` +
    openTint +
    ` ${dash}╮` +
    color.reset;
  const bottom = tint(`╰${"─".repeat(inner + 2)}╯`);
  const bar = tint("│");
  // pad() already works on plain text now; reset at end of each row for safety.
  const rows = lines.map((l) => `${bar} ${pad(l, inner)} ${bar}${color.reset}`);
  // Leading + trailing reset guarantees the terminal SGR state is clean before
  // and after the box, so the next prompt is never mis-colored.
  return color.reset + [top, ...rows, bottom].join("\n") + color.reset;
}
