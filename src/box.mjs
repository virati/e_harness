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
  const lines = wrapText(body, inner);
  const dash = "─".repeat(Math.max(0, inner - title.length - 1));
  const top = tint(`╭─ ${color.bold(title)}${tint(" " + dash + "╮")}`);
  const bottom = tint(`╰${"─".repeat(inner + 2)}╯`);
  const bar = tint("│");
  const rows = lines.map((l) => `${bar} ${pad(l, inner)} ${bar}`);
  return [top, ...rows, bottom].join("\n");
}
