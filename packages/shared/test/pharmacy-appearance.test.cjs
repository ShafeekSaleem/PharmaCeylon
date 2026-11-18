const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCENT_PRESETS, DEFAULT_PHARMACY_APPEARANCE, LIGHT_SURFACES, DARK_SURFACES,
  accentProblem, contrastRatio, deriveAccentTokens, pharmacyBrandCss, validatePharmacyAppearance,
} = require('../dist/pharmacy-appearance.js');

const AA = 4.5;
const atLeast = (fg, bg, min, what) =>
  assert.ok(contrastRatio(fg, bg) >= min, `${what}: ${fg} on ${bg} is ${contrastRatio(fg, bg).toFixed(2)}`);

/** Every preset, plus colours across the wheel that only just pass in light. */
const ACCENTS = [
  ...ACCENT_PRESETS.map((p) => p.hex),
  '#0b6b4f', '#7a1f1f', '#5b21b6', '#9d174d', '#1e3a8a', '#3f3f46', '#000000', '#4d5b00',
].filter((hex) => accentProblem(hex) === null);

test('every preset can be saved', () => {
  for (const { name, hex } of ACCENT_PRESETS) assert.equal(accentProblem(hex), null, name);
});

test('the default accent is a preset', () => {
  assert.ok(ACCENT_PRESETS.some((p) => p.hex === DEFAULT_PHARMACY_APPEARANCE.accent));
});

test('a light or malformed accent is refused with a reason', () => {
  assert.match(accentProblem('#0d9488'), /Too light to read: 3\.\d\d:1/);
  assert.match(accentProblem('#b45309'), /Too light/);
  assert.match(accentProblem('teal'), /six hex digits/);
  assert.match(accentProblem('#fff'), /six hex digits/);
  assert.equal(accentProblem('#0F766E'), null, 'upper case is accepted');
});

test('derived tokens meet the same contrast as tokens.css, in both themes', () => {
  for (const hex of ACCENTS) {
    const { light, dark } = deriveAccentTokens(hex);
    for (const s of LIGHT_SURFACES) atLeast(light.accent, s, AA, `${hex} light accent`);
    for (const s of DARK_SURFACES) atLeast(dark.accent, s, AA, `${hex} dark accent`);
    atLeast(light.ink, light.accent, AA, `${hex} light ink`);
    atLeast(light.ink, light.hover, AA, `${hex} light ink on hover`);
    atLeast(dark.ink, dark.accent, AA, `${hex} dark ink`);
    atLeast(dark.ink, dark.hover, AA, `${hex} dark ink on hover`);
    atLeast(light.accent, light.soft, AA, `${hex} light accent on soft`);
    atLeast(dark.accent, dark.soft, AA, `${hex} dark accent on soft`);
  }
});

test('the stylesheet mirrors tokens.css one step more specific', () => {
  const css = pharmacyBrandCss('#1d5fa8');
  assert.match(css, /^:root:root \{\n {2}--ui-accent: #1d5fa8;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:root:not\(\[data-theme="light"\]\) \{/);
  assert.match(css, /:root:root\[data-theme="dark"\] \{/);
});

test('validation accepts a full settings object and normalises the colour', () => {
  const result = validatePharmacyAppearance({ ...DEFAULT_PHARMACY_APPEARANCE, accent: '#1D5FA8' });
  assert.deepEqual(result, { ok: true, value: { ...DEFAULT_PHARMACY_APPEARANCE, accent: '#1d5fa8' } });
});

test('validation names the first problem', () => {
  const base = DEFAULT_PHARMACY_APPEARANCE;
  assert.match(validatePharmacyAppearance({ ...base, accent: '#22d3ee' }).error, /Too light/);
  assert.match(validatePharmacyAppearance({ ...base, sidebarStyle: 'neon' }).error, /sidebar/);
  assert.match(validatePharmacyAppearance({ ...base, statusSet: 'rainbow' }).error, /status colour/);
  assert.match(validatePharmacyAppearance({ ...base, counterThemeLocked: 'yes' }).error, /locked/);
  assert.equal(validatePharmacyAppearance(null).ok, false);
});
