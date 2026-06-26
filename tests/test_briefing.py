"""Tests for the PURE helpers in agent/briefing.py.

Scope is deliberately narrow: the streaming partial-JSON parser
``_iter_partial_takeaways`` and the env-var reader ``_brief_effort``. The
``generate_streaming`` async generator wraps the Claude Agent SDK ``query()``
and is intentionally NOT tested here — exercising it means fabricating SDK
``StreamEvent``/``AssistantMessage`` objects, which is out of scope.

Mock-free; ``monkeypatch`` only sets/clears env vars.
"""
from __future__ import annotations

from local_fitness.agent import briefing


# --- _iter_partial_takeaways: the streaming partial-JSON parser ------------
#
# Contract (read from briefing.py:96-134): a generator. It locates the
# ``"takeaways"`` key, then the opening ``[``, then raw_decodes one object at
# a time. It yields each *dict* whose 1-based parse position exceeds
# ``skip_count``. It stops (returns) on incomplete/malformed JSON, on the
# closing ``]``, or at end of text. A leading ```json fence is stripped.

def _collect(text: str, skip_count: int = 0) -> list[dict]:
    return list(briefing._iter_partial_takeaways(text, skip_count))


def test_empty_input_yields_nothing():
    assert _collect("") == []


def test_no_takeaways_key_yields_nothing():
    assert _collect('{"date": "2026-06-25", "summary": "hi"}') == []


def test_takeaways_key_but_no_open_bracket_yields_nothing():
    # The key is present but the array hasn't started streaming yet.
    assert _collect('{"takeaways"') == []
    assert _collect('{"takeaways":') == []


def test_single_complete_object_is_yielded():
    text = '{"takeaways": [{"headline": "Easy 5k", "tone": "positive"}]}'
    out = _collect(text)
    assert len(out) == 1
    assert out[0] == {"headline": "Easy 5k", "tone": "positive"}


def test_partial_trailing_object_is_not_yielded_yet():
    # First object is complete; second is still streaming in (no closing brace).
    text = (
        '{"takeaways": [{"headline": "first", "tone": "neutral"},'
        ' {"headline": "secon'
    )
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["first"]


def test_incomplete_first_object_yields_nothing():
    # The very first object is unterminated → raw_decode raises → stop.
    text = '{"takeaways": [{"headline": "Easy 5k", "tone": "posi'
    assert _collect(text) == []


def test_multiple_complete_objects_all_yielded():
    text = (
        '{"takeaways": ['
        '{"headline": "a", "tone": "neutral"},'
        '{"headline": "b", "tone": "positive"},'
        '{"headline": "c", "tone": "warning"}'
        ']}'
    )
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["a", "b", "c"]


def test_skip_count_skips_already_yielded_items():
    text = (
        '{"takeaways": ['
        '{"headline": "a", "tone": "neutral"},'
        '{"headline": "b", "tone": "positive"},'
        '{"headline": "c", "tone": "warning"}'
        ']}'
    )
    # skip_count=2 → only the 3rd (found > skip_count) is yielded.
    out = _collect(text, skip_count=2)
    assert [tk["headline"] for tk in out] == ["c"]


def test_skip_count_at_or_above_total_yields_nothing():
    text = '{"takeaways": [{"headline": "a", "tone": "neutral"}]}'
    assert _collect(text, skip_count=1) == []
    assert _collect(text, skip_count=5) == []


def test_boundary_object_completes_as_text_grows():
    # Simulate a growing LLM response: the second takeaway is only yielded
    # once its closing brace arrives.
    partial = '{"takeaways": [{"headline": "a", "tone": "neutral"}, {"headline": "b"'
    grown = partial + ', "tone": "positive"}]}'

    before = [tk["headline"] for tk in _collect(partial)]
    after = [tk["headline"] for tk in _collect(grown)]

    assert before == ["a"]
    assert after == ["a", "b"]
    # The streaming caller would pass skip_count=1 after yielding "a", so on
    # the grown text it emits only the newly-complete "b".
    assert [tk["headline"] for tk in _collect(grown, skip_count=1)] == ["b"]


def test_closing_bracket_stops_iteration():
    # Empty array: hits ``]`` immediately → no objects.
    assert _collect('{"takeaways": []}') == []


def test_leading_json_fence_is_stripped():
    text = '```json\n{"takeaways": [{"headline": "fenced", "tone": "neutral"}]}'
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["fenced"]


def test_bare_triple_backtick_fence_is_stripped():
    text = '```\n{"takeaways": [{"headline": "bare", "tone": "neutral"}]}'
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["bare"]


def test_inline_control_chars_stripped_before_parse():
    # A raw control char inside a string value would make strict JSON choke;
    # _strip_inline_control_chars (applied inside the helper) removes it so the
    # object still parses.
    text = '{"takeaways": [{"headline": "run\x07logged", "tone": "positive"}]}'
    out = _collect(text)
    assert len(out) == 1
    assert out[0]["headline"] == "runlogged"


def test_malformed_fragment_after_good_object_stops_cleanly():
    # First object parses; the next token is garbage (not an object) → the
    # parser stops without raising, having yielded the good one.
    text = '{"takeaways": [{"headline": "good", "tone": "neutral"}, not-json-here'
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["good"]


def test_whitespace_and_commas_between_objects_are_skipped():
    text = (
        '{"takeaways": [\n'
        '  {"headline": "a", "tone": "neutral"} ,\n\n'
        '  {"headline": "b", "tone": "positive"}\n'
        ']}'
    )
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["a", "b"]


def test_non_dict_array_items_are_not_yielded():
    # raw_decode succeeds on a non-dict (a string), but the ``isinstance(obj,
    # dict)`` guard means it is not yielded; the dict after it still is.
    text = '{"takeaways": ["stray", {"headline": "real", "tone": "neutral"}]}'
    out = _collect(text)
    assert [tk["headline"] for tk in out] == ["real"]


# --- _brief_effort: env-var matrix -----------------------------------------

_ENV = "LOCAL_FITNESS_BRIEF_EFFORT"


def test_brief_effort_unset_returns_default(monkeypatch):
    monkeypatch.delenv(_ENV, raising=False)
    assert briefing._brief_effort() == briefing._DEFAULT_BRIEF_EFFORT
    assert briefing._brief_effort() == "low"


def test_brief_effort_valid_values_passthrough(monkeypatch):
    for val in ("low", "medium", "high", "max"):
        monkeypatch.setenv(_ENV, val)
        assert briefing._brief_effort() == val


def test_brief_effort_normalizes_case_and_whitespace(monkeypatch):
    monkeypatch.setenv(_ENV, "  MAX  ")
    assert briefing._brief_effort() == "max"
    monkeypatch.setenv(_ENV, "High")
    assert briefing._brief_effort() == "high"


def test_brief_effort_invalid_value_falls_back_to_default(monkeypatch):
    monkeypatch.setenv(_ENV, "turbo")
    assert briefing._brief_effort() == briefing._DEFAULT_BRIEF_EFFORT


def test_brief_effort_empty_string_falls_back_to_default(monkeypatch):
    # Set-but-empty is distinct from unset: it is not None, strips to "", which
    # is not a valid effort → default.
    monkeypatch.setenv(_ENV, "   ")
    assert briefing._brief_effort() == briefing._DEFAULT_BRIEF_EFFORT
