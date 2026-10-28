import { DEFAULT_PANES, FONT_FAMILY_PRESETS, PANE_RANGES, useSettingsStore, type NumericPaneSetting, type PaneKey, type PaneSettings } from "../settings.store";
import { FIELD_LABELS, SECTIONS, type Section } from "../pane-sections.data";
import { PageHeader, TextRow } from "../SettingsFields";

function isPaneDefault(pane: PaneKey, settings: PaneSettings): boolean {
  const fields = SECTIONS.find((section) => section.pane === pane)?.fields ?? [];
  return fields.every((field) => settings[field] === DEFAULT_PANES[pane][field]);
}

export function PaneSettingsPage({ pane, title, hint, fields }: Section) {
  const settings = useSettingsStore((state) => state.panes[pane]);
  const resetPane = useSettingsStore((state) => state.resetPane);

  return (
    <section>
      <PageHeader title={title} hint={hint} isDefault={isPaneDefault(pane, settings)} onReset={() => resetPane(pane)} />
      <div className="flex flex-col gap-2">
        {fields.map((field) => {
          if (field === "background") return <ColorRow key={field} pane={pane} />;
          if (field === "fontFamily") return <FontFamilyRow key={field} pane={pane} />;
          return <NumberRow key={field} pane={pane} field={field} />;
        })}
      </div>
    </section>
  );
}

function NumberRow({ pane, field }: { pane: PaneKey; field: NumericPaneSetting }) {
  const value = useSettingsStore((state) => state.panes[pane][field]);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  const range = PANE_RANGES[field];
  const { label, unit } = FIELD_LABELS[field];
  const isDefault = value === DEFAULT_PANES[pane][field];
  const decimals = range.step < 1 ? 1 : 0;

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{label}</div>
      <div className="flex items-center rounded border border-neutral-600 bg-(--surface-input)">
        <StepButton label="−" onClick={() => setPaneSetting(pane, field, value - range.step)} disabled={value <= range.min} />
        <input
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value.toFixed(decimals)}
          onChange={(event) => setPaneSetting(pane, field, Number(event.target.value))}
          className="w-14 bg-transparent py-1 text-center text-sm tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <StepButton label="+" onClick={() => setPaneSetting(pane, field, value + range.step)} disabled={value >= range.max} />
      </div>
      <span className={`w-6 text-right text-[13px] ${isDefault ? "text-neutral-600" : "text-neutral-400"}`}>{unit}</span>
    </div>
  );
}

function ColorRow({ pane }: { pane: PaneKey }) {
  const value = useSettingsStore((state) => state.panes[pane].background);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  const isDefault = value === DEFAULT_PANES[pane].background;

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{FIELD_LABELS.background.label}</div>
      <label className="flex items-center gap-2 rounded border border-neutral-600 bg-(--surface-input) px-2 py-1">
        <input
          type="color"
          value={value}
          onChange={(event) => setPaneSetting(pane, "background", event.target.value)}
          className="size-5 cursor-pointer rounded border border-neutral-600 bg-transparent p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
          aria-label="Pick background color"
        />
        <span className="w-16 font-mono text-sm tabular-nums text-neutral-300">{value}</span>
      </label>
      <span className={`w-6 text-right text-[13px] ${isDefault ? "text-neutral-600" : "text-neutral-400"}`} />
    </div>
  );
}

/** Font stack of a pane, suggested from `FONT_FAMILY_PRESETS` and previewed in the field itself. */
function FontFamilyRow({ pane }: { pane: PaneKey }) {
  const value = useSettingsStore((state) => state.panes[pane].fontFamily);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  return (
    <TextRow
      label={FIELD_LABELS.fontFamily.label}
      ariaLabel="Font family"
      value={value}
      onChange={(family) => setPaneSetting(pane, "fontFamily", family)}
      presets={FONT_FAMILY_PRESETS}
      inputStyle={{ fontFamily: value }}
    />
  );
}

function StepButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center text-sm text-neutral-300 transition-colors hover:bg-(--row-hover) hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      {label}
    </button>
  );
}
