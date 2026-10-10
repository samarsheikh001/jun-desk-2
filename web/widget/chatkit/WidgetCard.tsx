import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { actionUrl, itemIds, OPEN_URL, widgetSummary, type MessageWidget, type WidgetActionConfig, type WidgetNode } from "../../../shared/widgets.ts";
import { WidgetChart } from "./chart.tsx";
import { hasIcon, iconSize, WidgetIcon } from "./icons.tsx";
import { background, block, box, color, imageSrc, insets, length, onTone, SEMANTIC, space, text, type Theme } from "./style.ts";
import "./chatkit.css";

// W-09 (D-43): draws a ChatKit widget tree (shared/widgets.ts) in the chat. Our own renderer for
// OpenAI's ChatKit widget format: components and props per ChatKit's spec (openai/chatkit-js
// widgets.d.ts, Apache-2.0), look after our chat's tokens, structure after @swis/genui-widgets
// (MIT, © swisnl). Used by the widget frame (Preact) and, read-only, by the inbox (React).
//
// The whole card is one <form>: any action sends what the visitor entered in the card's named
// fields (the server keeps only the card's own fields), and a submit or confirm checks required
// fields first. A used card (`widget.used`) stays visible with its controls off and says what was chosen.

export interface WidgetActionEvent {
  action: WidgetActionConfig;
  label: string;
  values: Record<string, string | boolean>;
  /** W-17: the list item it was pressed in. */
  item?: string;
}

interface Ctx {
  theme: Theme;
  /** The card's own actions are off (read-only, used, or one is being sent). */
  disabled: boolean;
  /** Read-only (history, inbox, streaming): nothing can be sent, though links still open. */
  readOnly: boolean;
  fire: (action: unknown, label: string, check: boolean, item?: string) => void;
  /** W-17: list item ids, and which items are used or being sent. */
  items: Map<WidgetNode, string>;
  itemState: (id: string) => { used: { label: string } | null; busy: boolean };
}

const WidgetCtx = createContext<Ctx>({ theme: "light", disabled: true, readOnly: true, fire: () => {}, items: new Map(), itemState: () => ({ used: null, busy: false }) });
/** W-17: the list item a control sits in (its own used state). */
/** A list row: its id, whether it's off, and (once used) the label of the button that used it. */
const ItemCtx = createContext<{ id?: string; disabled: boolean; used?: string }>({ disabled: false });

/** The row has a (non-link) button with this label: the press shows in its place. */
function hasButton(node: WidgetNode, label: string): boolean {
  if (node.type === "Button" && asAction(node.onClickAction)?.type !== OPEN_URL && (str(node.label) || asAction(node.onClickAction)?.type) === label) return true;
  return (node.children ?? []).some((c) => hasButton(c, label));
}

function asAction(value: unknown): WidgetActionConfig | null {
  return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? (value as WidgetActionConfig) : null;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v));

const TEXT_SIZES: Record<string, string> = { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "18px" };
const TITLE_SIZES: Record<string, string> = { sm: "15px", md: "17px", lg: "20px", xl: "24px", "2xl": "28px", "3xl": "34px", "4xl": "42px", "5xl": "52px" };
const CAPTION_SIZES: Record<string, string> = { sm: "11px", md: "12px", lg: "13px" };
const WEIGHTS: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

function textNode(node: WidgetNode, theme: Theme, sizes: Record<string, string>, base: { size: string; weight: number; className: string }): ReactNode {
  const style: CSSProperties = { ...text(node, theme), fontSize: sizes[str(node.size)] ?? sizes[base.size] };
  const weight = WEIGHTS[str(node.weight)];
  if (weight) style.fontWeight = weight;
  return (
    <div className={`${base.className}${node.truncate === true ? " ck-truncate" : ""}`} style={style}>
      {str(node.value)}
    </div>
  );
}

/** A tiny Markdown subset for ChatKit's Markdown component: paragraphs, lists, **bold**, *italic*, `code`, links. */
function Markdown({ value }: { value: string }) {
  const inline = (line: string, key: number): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g).map((part, i) => {
      const k = `${key}-${i}`;
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^`[^`]+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      if (/^\*[^*]+\*$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
      const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(part);
      if (link) return <a key={k} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
      return <Fragment key={k}>{part}</Fragment>;
    });
  const blocks = value.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="ck-md">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]!);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), j)}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l, j)] : inline(l, j)))}</p>;
      })}
    </div>
  );
}

const CONTROL_SIZES = new Set(["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"]);

function Button({ node }: { node: WidgetNode }) {
  const { theme, disabled: cardOff, fire } = useContext(WidgetCtx);
  const item = useContext(ItemCtx);
  const action = asAction(node.onClickAction);
  // A link opens even on a used or read-only card; in a list, a row is off once it's used.
  const link = action?.type === OPEN_URL;
  const disabled = link ? false : item.id ? item.disabled : cardOff;
  const label = str(node.label);
  const style = node.style === "primary" ? "primary" : node.style === "secondary" ? "secondary" : null;
  const tone = str(node.color) || (style === "primary" ? "primary" : "secondary");
  const variant = ["solid", "soft", "outline", "ghost"].includes(str(node.variant)) ? str(node.variant) : tone === "primary" || style === "primary" ? "solid" : "outline";
  const size = CONTROL_SIZES.has(str(node.size)) ? str(node.size) : "md";
  const c = SEMANTIC[tone] ?? color(tone, theme) ?? "var(--ck-text)";
  const submit = node.submit === true;
  const icons = iconSize(node.iconSize, 16);
  // W-17: in a used row, the button that was pressed becomes its check ("✓ Email"), not a dimmed copy beside one.
  if (item.used && !link && (label || action?.type) === item.used) {
    return (
      <span className="ck-item-done">
        <WidgetIcon name="check" size={13} />
        <span>{item.used}</span>
      </span>
    );
  }
  return (
    <button
      type={submit ? "submit" : "button"}
      // An icon-only button still needs a name for screen readers.
      {...(!label ? { "aria-label": link ? "Open link" : String(node.iconStart ?? node.iconEnd ?? action?.type ?? "Button").replace(/[-_]/g, " ") } : {})}
      className={`ck-btn ck-btn-${variant} ck-size-${size}${node.pill === true ? " ck-pill" : ""}${node.block === true ? " ck-block" : ""}${!label ? " ck-btn-icon" : ""}`}
      style={{ "--ck-tone": c, "--ck-on-tone": onTone(tone) } as CSSProperties}
      disabled={disabled || node.disabled === true || (!action && !submit)}
      onClick={submit || !action ? undefined : () => fire(action, label || action.type, false, item.id)}
    >
      {node.iconStart ? <WidgetIcon name={node.iconStart} size={icons} /> : null}
      {label && <span>{label}</span>}
      {node.iconEnd ? <WidgetIcon name={node.iconEnd} size={icons} /> : null}
    </button>
  );
}

function Badge({ node }: { node: WidgetNode }) {
  const { theme } = useContext(WidgetCtx);
  const name = str(node.color) || "secondary";
  const tone = SEMANTIC[name] ?? color(node.color, theme) ?? "var(--ck-text-2)";
  const variant = ["solid", "soft", "outline"].includes(str(node.variant)) ? str(node.variant) : "soft";
  const size = ["sm", "md", "lg"].includes(str(node.size)) ? str(node.size) : "sm";
  return <span className={`ck-badge ck-badge-${variant} ck-badge-${size}${node.pill === true ? " ck-pill" : ""}`} style={{ "--ck-tone": tone, "--ck-on-tone": onTone(SEMANTIC[name] ? name : "") } as CSSProperties}>{str(node.label)}</span>;
}

function Image({ node }: { node: WidgetNode }) {
  const src = imageSrc(node.src);
  const [broken, setBroken] = useState(false);
  if (!src || broken) return null;
  const style: CSSProperties = { borderRadius: "8px", ...block(node) };
  const fit = str(node.fit);
  if (["cover", "contain", "fill", "scale-down", "none"].includes(fit)) style.objectFit = fit as CSSProperties["objectFit"];
  if (typeof node.position === "string" && /^(top|bottom|left|right|center)( (left|right))?$/.test(node.position)) style.objectPosition = node.position;
  if (!style.width && !style.height && !node.flush) style.maxWidth = "100%";
  return (
    <img
      className={`ck-img${node.frame === true ? " ck-frame" : ""}${node.flush === true ? " ck-flush" : ""}`}
      src={src}
      alt={str(node.alt)}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={style}
      onError={() => setBroken(true)}
    />
  );
}

function fieldClass(node: WidgetNode, base: string) {
  const variant = str(node.variant) === "soft" ? "soft" : "outline";
  return `${base} ck-field-${variant}${node.pill === true ? " ck-pill" : ""}${node.block === true ? " ck-block" : ""}`;
}

function Input({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const type = ["number", "email", "text", "password", "tel", "url"].includes(str(node.inputType)) ? str(node.inputType) : "text";
  return (
    <input
      className={fieldClass(node, "ck-input")}
      name={str(node.name)}
      type={type}
      defaultValue={str(node.defaultValue)}
      placeholder={str(node.placeholder)}
      required={node.required === true}
      {...(typeof node.pattern === "string" ? { pattern: node.pattern } : {})}
      disabled={disabled || node.disabled === true}
      autoComplete="off"
    />
  );
}

function Textarea({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  return (
    <textarea
      className={fieldClass(node, "ck-input ck-textarea")}
      name={str(node.name)}
      defaultValue={str(node.defaultValue)}
      placeholder={str(node.placeholder)}
      required={node.required === true}
      rows={typeof node.rows === "number" ? Math.min(12, Math.max(1, node.rows)) : 3}
      disabled={disabled || node.disabled === true}
    />
  );
}

function Select({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const options = (Array.isArray(node.options) ? node.options : []) as { value?: unknown; label?: unknown }[];
  return (
    <select className={fieldClass(node, "ck-input ck-select")} name={str(node.name)} defaultValue={str(node.defaultValue)} required={node.required === true} disabled={disabled || node.disabled === true}>
      {(node.placeholder || !node.defaultValue) && <option value="" disabled={node.required === true}>{str(node.placeholder) || "Choose…"}</option>}
      {options.map((o, i) => <option key={i} value={str(o.value)}>{str(o.label ?? o.value)}</option>)}
    </select>
  );
}

function DatePicker({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
  return (
    <input
      className={fieldClass(node, "ck-input")}
      type="date"
      name={str(node.name)}
      defaultValue={day(node.defaultValue)}
      {...(node.min ? { min: day(node.min) } : {})}
      {...(node.max ? { max: day(node.max) } : {})}
      required={node.required === true}
      disabled={disabled || node.disabled === true}
    />
  );
}

function Checkbox({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  return (
    <label className="ck-check">
      <input type="checkbox" name={str(node.name)} defaultChecked={node.defaultChecked === true} required={node.required === true} disabled={disabled || node.disabled === true} />
      {node.label ? <span>{str(node.label)}</span> : null}
    </label>
  );
}

function RadioGroup({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const options = (Array.isArray(node.options) ? node.options : []) as { value?: unknown; label?: unknown; disabled?: unknown }[];
  return (
    <div className={`ck-radios${node.direction === "row" ? " ck-row-dir" : ""}`} role="radiogroup" aria-label={str(node.ariaLabel) || undefined}>
      {options.map((o, i) => (
        <label key={i} className="ck-check">
          <input type="radio" name={str(node.name)} value={str(o.value)} defaultChecked={str(node.defaultValue) === str(o.value)} required={node.required === true} disabled={disabled || node.disabled === true || o.disabled === true} />
          <span>{str(o.label ?? o.value)}</span>
        </label>
      ))}
    </div>
  );
}

function ListView({ node }: { node: WidgetNode }) {
  const items = node.children ?? [];
  const limit = typeof node.limit === "number" && node.limit > 0 ? node.limit : items.length;
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <div className="ck-list">
      {shown.map((child, i) => <Node key={str(child.key) || i} node={child} />)}
      {items.length > shown.length && (
        <button type="button" className="ck-more" onClick={() => setAll(true)}>
          Show {items.length - shown.length} more
        </button>
      )}
    </div>
  );
}

function ListViewItem({ node }: { node: WidgetNode }) {
  const { readOnly, disabled: cardOff, fire, items, itemState } = useContext(WidgetCtx);
  const id = items.get(node);
  const state = id ? itemState(id) : { used: null, busy: false };
  // W-17: each row is used on its own; the card being used (or read-only) turns them all off.
  const disabled = readOnly || cardOff || Boolean(state.used) || state.busy;
  const action = asAction(node.onClickAction);
  const style: CSSProperties = { gap: space(node.gap) ?? "12px" };
  if (typeof node.align === "string") style.alignItems = { start: "flex-start", end: "flex-end", center: "center", baseline: "baseline", stretch: "stretch" }[node.align] ?? "center";
  const children = (node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />);
  const done = state.used && !hasButton(node, state.used.label) ? (
    <span className="ck-item-done">
      <WidgetIcon name="check" size={13} />
      <span>{state.used.label}</span>
    </span>
  ) : null;
  const body = (
    <ItemCtx.Provider value={{ ...(id ? { id } : {}), disabled, ...(state.used ? { used: state.used.label } : {}) }}>
      {children}
      {done}
    </ItemCtx.Provider>
  );
  if (!action) return <div className={`ck-item${state.used ? " ck-item-used" : ""}`} style={style}>{body}</div>;
  const label = (node.children ?? []).map((c) => str(c.value)).filter(Boolean)[0] ?? action.type;
  const link = action.type === OPEN_URL;
  return (
    <div
      className={`ck-item ck-item-btn${state.used ? " ck-item-used" : ""}`}
      style={style}
      role="button"
      tabIndex={disabled && !link ? -1 : 0}
      aria-disabled={disabled && !link}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, select, textarea, label")) return; // its own controls
        if (link || !disabled) fire(action, label, false, id);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (link || !disabled)) {
          e.preventDefault();
          fire(action, label, false, id);
        }
      }}
    >
      {body}
    </div>
  );
}

function Table({ node }: { node: WidgetNode }) {
  return (
    <div className="ck-table-wrap">
      <table className="ck-table">
        <tbody>
          {(node.children ?? []).map((row, i) => (
            <tr key={str(row.key) || i} className={row.header === true ? "ck-th" : undefined}>
              {(row.children ?? []).map((cell, j) => {
                const style: CSSProperties = { ...insets("padding", cell.padding) };
                const w = length(cell.width);
                if (w) style.width = w;
                if (cell.align === "center" || cell.align === "end") style.textAlign = cell.align;
                if (cell.vAlign === "start" || cell.vAlign === "center" || cell.vAlign === "end") style.verticalAlign = cell.vAlign === "start" ? "top" : cell.vAlign === "end" ? "bottom" : "middle";
                const span = { ...(typeof cell.colSpan === "number" ? { colSpan: cell.colSpan } : {}), ...(typeof cell.rowSpan === "number" ? { rowSpan: cell.rowSpan } : {}) };
                const Cell = row.header === true ? "th" : "td";
                return (
                  <Cell key={str(cell.key) || j} style={style} {...span}>
                    {(cell.children ?? []).map((c, k) => <Node key={str(c.key) || k} node={c} />)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Container({ node, dir, className = "" }: { node: WidgetNode; dir: "row" | "col"; className?: string }) {
  const { theme, disabled: cardOff, fire } = useContext(WidgetCtx);
  const item = useContext(ItemCtx);
  const disabled = item.id ? item.disabled : cardOff;
  const style = box(node, theme);
  const click = asAction(node.onClickAction);
  const children = (node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />);
  const cls = `ck-box ck-${dir}${className}${node.flush === true ? " ck-flush" : ""}`;
  if (node.type === "Form") {
    // A Form inside the card's form: its submit button sends the Form's action (validated first).
    const submit = asAction(node.onSubmitAction);
    return (
      <div
        className={cls}
        style={style}
        onClickCapture={(e) => {
          const target = e.target as HTMLElement;
          const btn = target.closest("button[type=submit]") as HTMLButtonElement | null;
          if (!btn || !submit) return;
          e.preventDefault();
          fire(submit, btn.textContent?.trim() || "Submit", true, item.id);
        }}
      >
        {children}
      </div>
    );
  }
  if (click) {
    return (
      <div className={`${cls} ck-clickable`} style={style} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onClick={() => !disabled && fire(click, click.type, false, item.id)}>
        {children}
      </div>
    );
  }
  return <div className={cls} style={style}>{children}</div>;
}

function Node({ node }: { node: WidgetNode }): ReactNode {
  const { theme } = useContext(WidgetCtx);
  switch (node.type) {
    case "Box":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Row":
      return <Container node={node} dir="row" />;
    case "Col":
    case "Form":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Basic":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Card":
      return <Card node={node} nested />;
    case "ListView":
      return <ListView node={node} />;
    case "ListViewItem":
      return <ListViewItem node={node} />;
    case "Spacer": {
      const min = length(node.minSize);
      return <div className="ck-spacer" style={min ? { minWidth: min, minHeight: min } : undefined} />;
    }
    case "Divider": {
      const c = color(node.color, theme, "border");
      const size = length(node.size);
      const spacing = space(node.spacing);
      return <hr className={`ck-divider${node.flush === true ? " ck-flush" : ""}`} style={{ ...(c ? { borderColor: c } : {}), ...(size ? { borderTopWidth: size } : {}), ...(spacing ? { marginBlock: spacing } : {}) }} />;
    }
    case "Transition":
      return <>{(node.children ?? []).map((c, i) => <Node key={i} node={c} />)}</>;
    case "Table":
      return <Table node={node} />;
    case "Text": {
      const editable = node.editable && typeof node.editable === "object" ? (node.editable as Record<string, unknown>) : null;
      if (editable && typeof editable.name === "string") {
        return <EditableText node={node} editable={editable} />;
      }
      return textNode(node, theme, TEXT_SIZES, { size: "md", weight: 400, className: "ck-text" });
    }
    case "Title":
      return textNode(node, theme, TITLE_SIZES, { size: "md", weight: 600, className: "ck-title" });
    case "Caption":
      return textNode(node, theme, CAPTION_SIZES, { size: "md", weight: 400, className: "ck-caption" });
    case "Label": {
      const style: CSSProperties = { ...text(node, theme), fontSize: TEXT_SIZES[str(node.size)] ?? "13px" };
      const weight = WEIGHTS[str(node.weight)];
      if (weight) style.fontWeight = weight;
      return <label className="ck-label" style={style}>{str(node.value)}</label>;
    }
    case "Markdown":
      return <Markdown value={str(node.value)} />;
    case "Badge":
      return <Badge node={node} />;
    case "Icon":
      return <WidgetIcon name={node.name} size={iconSize(node.size, 16)} color={color(node.color, theme)} />;
    case "Image":
      return <Image node={node} />;
    case "Chart":
      return <WidgetChart node={node} theme={theme} />;
    case "Button":
      return <Button node={node} />;
    case "Input":
      return <Input node={node} />;
    case "Textarea":
      return <Textarea node={node} />;
    case "Select":
      return <Select node={node} />;
    case "DatePicker":
      return <DatePicker node={node} />;
    case "Checkbox":
      return <Checkbox node={node} />;
    case "RadioGroup":
      return <RadioGroup node={node} />;
    default:
      return null;
  }
}

function EditableText({ node, editable }: { node: WidgetNode; editable: Record<string, unknown> }) {
  const { theme, disabled } = useContext(WidgetCtx);
  const style: CSSProperties = { ...text(node, theme), fontSize: TEXT_SIZES[str(node.size)] ?? "14px" };
  const weight = WEIGHTS[str(node.weight)];
  if (weight) style.fontWeight = weight;
  const multi = typeof node.minLines === "number" && node.minLines > 1;
  const props = {
    className: "ck-input ck-editable",
    name: str(editable.name),
    defaultValue: str(node.value),
    placeholder: str(editable.placeholder),
    required: editable.required === true,
    disabled,
    style,
  };
  return multi ? <textarea rows={node.minLines as number} {...props} /> : <input type="text" {...(typeof editable.pattern === "string" ? { pattern: editable.pattern } : {})} {...props} />;
}

function Status({ status }: { status: unknown }) {
  if (!status || typeof status !== "object") return null;
  const s = status as { text?: unknown; icon?: unknown; favicon?: unknown };
  const favicon = imageSrc(s.favicon);
  return (
    <div className="ck-status">
      {favicon ? <img src={favicon} alt="" width={14} height={14} referrerPolicy="no-referrer" /> : s.icon ? <WidgetIcon name={s.icon} size={14} /> : null}
      <span>{str(s.text)}</span>
    </div>
  );
}

/**
 * In a bare WidgetCard, the root Card draws flat (`bare`: no frame, no side padding) unless it has
 * its own background or a theme of its own: then it's a tile (`tile`: background and radius only).
 */
function Card({ node, nested = false, look = "frame" }: { node: WidgetNode; nested?: boolean; look?: "frame" | "bare" | "tile" }) {
  const { theme, fire, disabled } = useContext(WidgetCtx);
  const flat = look === "bare";
  const style: CSSProperties = flat
    ? box({ ...node, padding: undefined, size: undefined, width: undefined, height: undefined, border: undefined, background: undefined, radius: undefined, margin: undefined }, theme)
    : { ...insets("padding", node.padding ?? 4), ...box({ ...node, padding: undefined, size: undefined, width: undefined, height: undefined }, theme) };
  const pad = flat ? "0px" : (space(typeof node.padding === "number" ? node.padding : 4) ?? "16px");
  const confirm = node.confirm && typeof node.confirm === "object" ? (node.confirm as { label?: unknown; action?: unknown }) : null;
  const cancel = node.cancel && typeof node.cancel === "object" ? (node.cancel as { label?: unknown; action?: unknown }) : null;
  const dark = node.theme === "dark" ? " ck-dark" : node.theme === "light" ? " ck-light" : "";
  const bg = flat ? undefined : background(node.background, theme);
  return (
    <>
      {!nested && <Status status={node.status} />}
      <div className={`ck-card ck-card-${["sm", "md", "lg", "full"].includes(str(node.size)) ? str(node.size) : "md"}${look === "frame" ? "" : ` ck-card-${look}`}${dark}`} style={{ ...style, ...(bg ? { background: bg } : {}), "--ck-pad": pad } as CSSProperties}>
        {(node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />)}
        {(confirm || cancel) && (
          <div className="ck-card-actions">
            {confirm && asAction(confirm.action) && (
              <button type="button" className="ck-btn ck-btn-solid ck-size-md" style={{ "--ck-tone": "var(--ck-accent)", "--ck-on-tone": "var(--ck-accent-text)" } as CSSProperties} disabled={disabled} onClick={() => fire(confirm.action, str(confirm.label) || "Confirm", true)}>
                {str(confirm.label) || "Confirm"}
              </button>
            )}
            {cancel && asAction(cancel.action) && (
              <button type="button" className="ck-btn ck-btn-outline ck-size-md" style={{ "--ck-tone": "var(--ck-text)" } as CSSProperties} disabled={disabled} onClick={() => fire(cancel.action, str(cancel.label) || "Cancel", false)}>
                {str(cancel.label) || "Cancel"}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** What the visitor entered in the card's named fields. */
function collect(form: HTMLFormElement): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const el of Array.from(form.elements) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]) {
    if (!el.name) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") values[el.name] = el.checked;
    else if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) values[el.name] = el.value;
    } else values[el.name] = el.value;
  }
  return values;
}

/**
 * One widget the AI showed. `onAction` is called when the visitor presses one of its actions
 * (never while `interactive` is false: history the AI isn't waiting on, the inbox, a streaming reply).
 */
export function WidgetCard({
  widget,
  interactive,
  onAction,
  theme = "light",
  desk = false,
  bare = false,
}: {
  widget: MessageWidget;
  interactive: boolean;
  onAction?: (event: WidgetActionEvent) => void;
  theme?: Theme;
  /** In the dashboard: its colour tokens instead of the widget frame's. */
  desk?: boolean;
  /**
   * The card is the answer itself, inside a host with its own surface and ~16–20px side padding
   * (the island): no outer frame, content at the host's text edge. A root Card with its own
   * background or theme stays a tile. See chatkit.css "Bare".
   */
  bare?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  // What's being sent: "card", or a list item's id. A failed send (used elsewhere, socket dropped) can be retried.
  const [sending, setSending] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!sending.size) return;
    const t = setTimeout(() => setSending(new Set()), 8000);
    return () => clearTimeout(t);
  }, [sending]);
  // The server's answer (the card or row marked used) ends the wait.
  useEffect(() => setSending(new Set()), [widget.used, widget.items]);
  const used = widget.used ?? null;
  const readOnly = !interactive || !onAction;
  const disabled = readOnly || Boolean(used) || sending.has("card");
  const ids = useMemo(() => itemIds(widget.root), [widget.root]);
  const ctx: Ctx = {
    theme,
    disabled,
    readOnly,
    items: ids,
    itemState: (id) => ({ used: widget.items?.[id] ?? null, busy: sending.has(id) }),
    fire: (action, label, check, item) => {
      const a = asAction(action);
      if (!a || !form.current) return;
      // W-17: a link opens here; nothing is sent and nothing is used.
      if (a.type === OPEN_URL) {
        const url = actionUrl(a);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      if (readOnly || used || sending.has(item ?? "card") || (item && widget.items?.[item])) return;
      if (check && !form.current.reportValidity()) return;
      setSending((s) => new Set(s).add(item ?? "card"));
      onAction?.({ action: { type: a.type, ...(a.payload !== undefined ? { payload: a.payload } : {}) }, label, values: collect(form.current), ...(item ? { item } : {}) });
    },
  };
  const root = widget.root;
  const tile = Boolean(background(root.background, theme)) || ((root.theme === "dark" || root.theme === "light") && root.theme !== theme);
  return (
    <WidgetCtx.Provider value={ctx}>
      <form ref={form} className={`ck${desk ? " ck-desk" : ""}${theme === "dark" ? " ck-dark" : ""}${bare ? " ck-bare" : ""}${used ? " ck-used" : ""}`} onSubmit={(e) => e.preventDefault()} noValidate={false} aria-label={widget.name}>
        {root.type === "Card" ? <Card node={root} look={!bare ? "frame" : tile ? "tile" : "bare"} /> : root.type === "ListView" ? (
          <>
            <Status status={root.status} />
            <div className={`ck-card ck-card-list${bare ? " ck-card-bare" : ""}`}><ListView node={root} /></div>
          </>
        ) : (
          <Container node={root} dir={root.direction === "row" ? "row" : "col"} className=" ck-basic" />
        )}
        {used && (
          <div className="ck-used-note">
            <WidgetIcon name="check" size={13} />
            <span>{used.label}</span>
          </div>
        )}
      </form>
    </WidgetCtx.Provider>
  );
}

/** The icon a card stands for: its status favicon or icon, else a generic card. */
function peekIcon(root: WidgetNode): ReactNode {
  const s = root.status && typeof root.status === "object" ? (root.status as { icon?: unknown; favicon?: unknown }) : {};
  const favicon = imageSrc(s.favicon);
  if (favicon) return <img src={favicon} alt="" width={16} height={16} referrerPolicy="no-referrer" />;
  return <WidgetIcon name={hasIcon(s.icon) ? s.icon : root.type === "ListView" ? "batch" : "square-text"} size={16} />;
}

/**
 * A folded card: one slim row (~40px) with the card's icon, its one-line summary and a chevron.
 * Pressing it calls `onOpen` (the host unfolds the card).
 */
export function WidgetPeek({ widget, theme, onOpen }: { widget: MessageWidget; theme?: "light" | "dark"; onOpen: () => void }) {
  const summary = useMemo(() => widgetSummary(widget.root), [widget.root]) || widget.name;
  return (
    <button type="button" className={`ck-peek${theme === "dark" ? " ck-dark" : ""}`} aria-label={`Show ${summary}`} onClick={onOpen}>
      <span className="ck-peek-icon" aria-hidden="true">{peekIcon(widget.root)}</span>
      <span className="ck-peek-text">{summary}</span>
      <span className="ck-peek-chev" aria-hidden="true"><WidgetIcon name="chevron-right" size={14} /></span>
    </button>
  );
}
