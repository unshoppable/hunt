"""Builds the "Code Monospace V2" family from the v3.0 Medium and Medium Italic files.

Medium: every glyph gets the 550-unit advance, re-centered; the asterisks sit on the height of `+` instead of the
source's superscript height, where they touch the neighbouring slashes of `/*/`.
Medium Italic: lowercase letters keep their cursive outlines (re-centered to 550); every other glyph is the
Medium outline sheared by the font's italic angle, so skew, weight and position are uniform. The ligatures
(`calt`/`liga`: components become the empty `LIG` glyph, the last one the `*.liga` drawing) were built on a 600-unit
grid and are scaled horizontally onto the 550-unit cell.
"""
import copy, math, os, sys, unicodedata
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables import ttProgram

HOME = os.path.expanduser("~")
SRC_REG = f"{HOME}/Library/Fonts/code-monospace-medium-v3.0.ttf"
SRC_ITA = f"{HOME}/Library/Fonts/code-monospace-italic-v3.0.ttf"
FAMILY = "Code Monospace V2"
ADVANCE = 550
ITALIC_ANGLE = -11.0
SHEAR_PIVOT_Y = 250  # roughly half the x-height: keeps the visual center of a sheared glyph in place
LIGATURE_GRID = 600


def shear_glyph(glyph, glyf, tan):
    """Returns a copy of `glyph` with x' = x + (y - pivot) * tan; hinting is dropped."""
    g = copy.deepcopy(glyph)
    if g.numberOfContours == 0:
        return g
    coords, end_pts, flags = g.getCoordinates(glyf)
    coords = coords.copy()
    for i, (x, y) in enumerate(coords):
        coords[i] = (round(x + (y - SHEAR_PIVOT_Y) * tan), y)
    g.coordinates = coords
    g.program = ttProgram.Program()
    g.recalcBounds(glyf)
    return g


def shift_glyph(glyph, glyf, dx, dy=0):
    g = copy.deepcopy(glyph)
    if g.numberOfContours == 0 or (dx == 0 and dy == 0):
        return g
    coords, _, _ = g.getCoordinates(glyf)
    coords = coords.copy()
    for i, (x, y) in enumerate(coords):
        coords[i] = (x + dx, y + dy)
    g.coordinates = coords
    g.program = ttProgram.Program()
    g.recalcBounds(glyf)
    return g


def scale_x(glyph, glyf, factor):
    g = copy.deepcopy(glyph)
    if g.numberOfContours == 0:
        return g
    coords, _, _ = g.getCoordinates(glyf)
    coords = coords.copy()
    for i, (x, y) in enumerate(coords):
        coords[i] = (round(x * factor), y)
    g.coordinates = coords
    g.program = ttProgram.Program()
    g.recalcBounds(glyf)
    return g


def lower_asterisks(font, tan=0.0):
    """Moves `asterisk` and `asterisk.alt` down until their vertical center matches the one of `plus`; a sheared
    (italic) glyph also moves left by the shear so that it stays on the slant."""
    glyf = font["glyf"]
    plus = glyf["plus"]
    plus_center = (plus.yMin + plus.yMax) / 2
    for name in ("asterisk", "asterisk.alt"):
        glyph = glyf[name]
        dy = round(plus_center - (glyph.yMin + glyph.yMax) / 2)
        glyph = shift_glyph(glyph, glyf, round(dy * tan), dy)
        glyf[name] = glyph
        font["hmtx"].metrics[name] = (font["hmtx"].metrics[name][0], glyph.xMin)


def fit_ligatures(font):
    """Scales the ligature glyphs from their 600-unit design grid onto the cell width; `LIG` is the empty spacer."""
    glyf = font["glyf"]
    names = [g for g in font.getGlyphOrder() if g.endswith(".liga") or g == "LIG"]
    for name in names:
        glyph = scale_x(glyf[name], glyf, ADVANCE / LIGATURE_GRID)
        glyf[name] = glyph
        lsb = glyph.xMin if glyph.numberOfContours else 0
        font["hmtx"].metrics[name] = (ADVANCE, lsb)
    return names


def set_width(font, name, width):
    glyf = font["glyf"]
    glyph = glyf[name]
    old_width, _ = font["hmtx"].metrics[name]
    dx = round((width - old_width) / 2)
    if dx:
        glyph = shift_glyph(glyph, glyf, dx)
        glyf[name] = glyph
    lsb = getattr(glyph, "xMin", 0) if glyph.numberOfContours else 0
    font["hmtx"].metrics[name] = (width, lsb)


def rename(font, style, italic):
    name = font["name"]
    full = f"{FAMILY} {style}"
    ps = f"{FAMILY.replace(' ', '')}-{style.replace(' ', '')}"
    # Name IDs 1/2 are the legacy family/subfamily pair: macOS links the italic to the family only when ID 2 is
    # one of the four standard styles, so the full style name goes into ID 17.
    for rec in list(name.names):
        if rec.nameID in (1, 16):
            rec.string = FAMILY
        elif rec.nameID == 2:
            rec.string = "Italic" if italic else "Regular"
        elif rec.nameID == 17:
            rec.string = style
        elif rec.nameID == 3:
            rec.string = f"{FAMILY};{style};V2"
        elif rec.nameID == 4:
            rec.string = full
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 5:
            rec.string = "Version 2.000"
    font["head"].macStyle = 2 if italic else 0
    os2 = font["OS/2"]
    os2.fsSelection = (os2.fsSelection & ~0b1000001) | (0b1 if italic else 0b1000000)
    os2.usWeightClass = 500
    os2.panose.bProportion = 9  # monospaced
    font["post"].isFixedPitch = 1
    font["post"].italicAngle = ITALIC_ANGLE if italic else 0.0
    hhea = font["hhea"]
    hhea.caretSlopeRise = 1000 if italic else 1
    hhea.caretSlopeRun = round(1000 * math.tan(math.radians(-ITALIC_ANGLE))) if italic else 0


def build():
    reg = TTFont(SRC_REG)
    ita = TTFont(SRC_ITA)

    # --- Medium: uniform advance
    changed_reg = []
    for cp, name in reg.getBestCmap().items():
        if reg["hmtx"].metrics[name][0] != ADVANCE:
            set_width(reg, name, ADVANCE)
            changed_reg.append(chr(cp))
    lower_asterisks(reg)
    rename(reg, "Medium", italic=False)

    # --- Medium Italic
    tan = math.tan(math.radians(-ITALIC_ANGLE))
    reg_src = TTFont(SRC_REG)  # outlines before re-centering as the shear source
    lower_asterisks(reg_src)
    lower_asterisks(ita, tan)
    reg_cmap = reg_src.getBestCmap()
    ita_cmap = ita.getBestCmap()
    glyf_i = ita["glyf"]; glyf_r = reg_src["glyf"]
    kept, regenerated, missing = [], [], []
    for cp, name in ita_cmap.items():
        ch = chr(cp)
        is_lower = unicodedata.category(ch) == "Ll"
        if is_lower or cp not in reg_cmap:
            if cp not in reg_cmap and not is_lower:
                missing.append(ch)
            set_width(ita, name, ADVANCE)
            kept.append(ch)
            continue
        src = glyf_r[reg_cmap[cp]]
        new = shear_glyph(src, glyf_r, tan)
        glyf_i[name] = new
        src_width = reg_src["hmtx"].metrics[reg_cmap[cp]][0]
        ita["hmtx"].metrics[name] = (src_width, getattr(new, "xMin", 0) if new.numberOfContours else 0)
        set_width(ita, name, ADVANCE)
        regenerated.append(ch)
    ligatures = fit_ligatures(ita)
    rename(ita, "Medium Italic", italic=True)
    for f in (reg, ita):
        f["head"].fontRevision = 2.0
        if "FFTM" in f:
            del f["FFTM"]
    reg.save("out/CodeMonospaceV2-Medium.ttf")
    ita.save("out/CodeMonospaceV2-MediumItalic.ttf")
    print("medium: re-centered", "".join(changed_reg))
    print("italic: kept cursive", len(kept), "".join(kept)[:80])
    print("italic: regenerated", len(regenerated), "".join(regenerated)[:120])
    print("italic: kept without regular source", "".join(missing))
    print("italic: ligature glyphs fitted", len(ligatures))


build()
