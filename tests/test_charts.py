"""Tests for agent/charts.py — the pure terminal-chart renderers.

No DB, no SDK: these assert the deterministic structure of the rendered strings
and the edge cases that bit the prototype (empty windows, flat series, single
points, and negative series like TSB / freshness)."""
from __future__ import annotations

from local_fitness.agent import charts


# --- render_bar_chart ---------------------------------------------------------

def test_bar_chart_one_row_per_point_with_formatted_value():
    out = charts.render_bar_chart(["06-01", "06-02"], [10, 20], value_fmt=lambda v: f"{int(v)}")
    lines = out.split("\n")
    assert len(lines) == 2
    assert lines[0].startswith("06-01") and lines[0].endswith(" 10")
    assert lines[1].endswith(" 20")
    # Bigger value → at least as many emoji squares as the smaller one.
    assert lines[1].count("🟥") + lines[1].count("🟧") + lines[1].count("🟨") >= 1


def test_bar_chart_zero_value_is_an_empty_bar():
    # Non-negative series scales from zero, so a 0 renders no squares — honest
    # for steps / intensity minutes (a rest day reads as empty, not min-height).
    out = charts.render_bar_chart(["d1", "d2"], [0, 100])
    first = out.split("\n")[0]
    assert all(sq not in first for sq in charts._HEAT)


def test_bar_chart_empty_returns_no_data():
    assert charts.render_bar_chart([], []) == charts._NO_DATA
    assert charts.render_bar_chart([], [], title="rhr").startswith("rhr\n")


def test_bar_chart_flat_negative_series_renders_full_bars():
    # Significant 2: an all-equal NEGATIVE series (the TSB / freshness shape) must
    # still draw squares. Pre-fix frac=(v-lo)/span==0 → empty bars / blank chart.
    out = charts.render_bar_chart(["a", "b", "c"], [-5.0, -5.0, -5.0])
    for line in out.split("\n"):
        assert any(sq in line for sq in charts._HEAT)


def test_bar_chart_all_zero_window_renders_empty_bars():
    # Finding 1: a flat all-zero non-negative window (a rest-day stretch) honors
    # the "zero = empty bar" contract — no squares. Pre-fix the flat branch forced
    # frac=1.0 and drew full bars labeled 0, contradicting the docstring.
    out = charts.render_bar_chart(["a", "b"], [0, 0])
    for line in out.split("\n"):
        assert all(sq not in line for sq in charts._HEAT)


def test_bar_chart_flat_nonzero_window_still_full():
    # Guard the prior fix: a flat non-zero positive series (all-5) still fills.
    out = charts.render_bar_chart(["a", "b"], [5, 5])
    for line in out.split("\n"):
        assert any(sq in line for sq in charts._HEAT)
    # And a flat-negative series (TSB shape) still fills too — not regressed.
    neg = charts.render_bar_chart(["a", "b"], [-5.0, -5.0])
    for line in neg.split("\n"):
        assert any(sq in line for sq in charts._HEAT)


def test_bar_chart_flat_series_is_sign_consistent():
    # A flat positive and a flat negative series must render the same bar width —
    # no asymmetry where positive fills and negative goes blank.
    pos = charts.render_bar_chart(["a", "b"], [5.0, 5.0]).split("\n")
    neg = charts.render_bar_chart(["a", "b"], [-5.0, -5.0]).split("\n")
    for p, n in zip(pos, neg):
        assert p.count("🟦") + p.count("🟩") + p.count("🟨") + p.count("🟧") + p.count("🟥") == \
               n.count("🟦") + n.count("🟩") + n.count("🟨") + n.count("🟧") + n.count("🟥")


# --- render_combo_chart -------------------------------------------------------

def test_combo_chart_has_axis_bars_and_trendline():
    out = charts.render_combo_chart(["a", "b", "c"], [1, 2, 3])
    assert "┤" in out and "└" in out  # y-axis + baseline
    assert "█" in out                  # bars
    assert "•" in out                  # trend marker
    assert "rising" in out             # monotonic up → positive slope


def test_combo_chart_handles_negative_series():
    # TSB / freshness lives below zero; the renderer must not crash or clip.
    tsb = [-9.8, -17.4, -31.1, -13.1]
    out = charts.render_combo_chart(["a", "b", "c", "d"], tsb, value_fmt=lambda v: f"{v:.0f}")
    assert "-31" in out  # the trough appears as an axis label
    assert "█" in out and "•" in out


def test_combo_chart_trend_footer_is_unit_consistent():
    # Significant 1: the footer reports formatted endpoints with the SAME value_fmt
    # as the axis — never a raw-unit per-step slope. A seconds→hours formatter must
    # produce an "h" footer with a "→", not a bare raw-seconds "/step" number.
    def secs(v):
        return f"{v / 3600:.1f}h"
    out = charts.render_combo_chart(["a", "b", "c"], [27000.0, 27360.0, 27720.0], value_fmt=secs)
    footer = [ln for ln in out.split("\n") if "trend" in ln][0]
    assert "→" in footer
    assert "h" in footer        # formatted in hours, matching the axis
    assert "/step" not in footer
    # The raw-seconds slope must not leak into the footer as a bare number.
    assert "180" not in footer and "360" not in footer


def test_combo_chart_trend_footer_endpoints_match_fit():
    # Endpoints are the least-squares fit's first/last, formatted — falling rhr
    # reads "55 → 53 · falling".
    out = charts.render_combo_chart(["a", "b", "c"], [55, 54, 53], value_fmt=lambda v: f"{int(round(v))}")
    footer = [ln for ln in out.split("\n") if "trend" in ln][0]
    assert "55 → 53" in footer
    assert "falling" in footer


def test_combo_chart_footer_endpoints_clamped_to_data_range():
    # Finding 2: the least-squares line extrapolates past the data here (fit
    # endpoints ~48 and ~57), but the axis only spans [50, 60] and the on-canvas
    # • is pinned inside that range. The footer must report values inside [min,max]
    # so it agrees with both the axis and the marker — direction word unchanged.
    vals = [50, 50, 50, 60]
    out = charts.render_combo_chart(["a", "b", "c", "d"], vals, value_fmt=lambda v: f"{int(round(v))}")
    footer = [ln for ln in out.split("\n") if "trend" in ln][0]
    lo, hi = min(vals), max(vals)
    # Parse the two reported endpoint numbers out of "trend X → Y · rising".
    start_s, rest = footer.split("trend", 1)[1].split("→", 1)
    end_s = rest.split("·", 1)[0]
    start_v, end_v = int(start_s.strip()), int(end_s.strip())
    assert lo <= start_v <= hi
    assert lo <= end_v <= hi
    assert "rising" in footer  # true slope sign survives the clamp


def test_combo_chart_flat_series_is_flat_not_crash():
    out = charts.render_combo_chart(["a", "b", "c"], [5, 5, 5])
    assert "flat" in out


def test_combo_chart_flat_series_still_renders_bars():
    # Significant 1: an all-equal series must still draw bars — the trend marker
    # may only steal the top cell, not erase the whole bar.
    out = charts.render_combo_chart(["a", "b", "c"], [5, 5, 5])
    assert "█" in out
    assert "•" in out


def test_combo_chart_flat_series_does_not_invent_an_axis_range():
    # Significant 2: a constant -5.0 series must convey the single value, not a
    # fabricated -5.0 / -4.5 / -4.0 spread the data never covers.
    out = charts.render_combo_chart(["a", "b", "c"], [-5.0, -5.0, -5.0], value_fmt=lambda v: f"{v:.1f}")
    assert "-5.0" in out          # the real constant value appears
    assert "-4.5" not in out      # no phantom mid-range label
    assert "-4.0" not in out      # no phantom top-range label


def test_combo_chart_axis_column_is_straight_for_fractional_midpoint():
    # Minor A: with the default {v:g} formatter the midpoint label (1.5) is wider
    # than the integer endpoints (0 / 3); the ┤ column must still line up.
    out = charts.render_combo_chart(["a", "b"], [0, 3])
    bar_lines = [ln for ln in out.split("\n") if "┤" in ln]
    positions = {ln.index("┤") for ln in bar_lines}
    assert len(positions) == 1  # every axis row puts ┤ in the same column
    assert "1.5" in out         # the wider midpoint label is what we widened for


# --- render_sparkline ---------------------------------------------------------

def test_sparkline_one_glyph_per_point():
    out = charts.render_sparkline([1, 2, 3, 4, 5])
    assert len(out) == 5
    assert all(ch in charts._BLOCKS for ch in out)


def test_sparkline_flat_and_single_and_empty():
    assert charts.render_sparkline([7, 7, 7]) == "▁▁▁"  # flat → lowest block, no div/0
    assert len(charts.render_sparkline([42])) == 1
    assert charts.render_sparkline([]) == charts._NO_DATA
