from firevoice.frontend import normalize, parse, make_chunks, split_sentences
from firevoice.frontend.chunker import gap_after_ms
from firevoice.types import Pause, Segment


def test_numbers_and_symbols():
    assert normalize("17% of PRs in 2026") == "seventeen percent of P Rs in twenty twenty-six"
    assert normalize("40%+") == "forty percent or more"
    assert normalize("17.9B pushes") == "seventeen point nine billion pushes"
    assert normalize("$1.3B") == "one point three billion dollars"
    assert normalize("1,210 PRs") == "one thousand, two hundred and ten P Rs"
    assert normalize("the 3rd time") == "the third time"
    assert normalize("2025-2026") == "twenty twenty-five to twenty twenty-six"


def test_lexicon_whole_word_only():
    assert normalize("AI is fine, MAIL is not AI") == "A I is fine, MAIL is not A I"
    assert normalize("GitHub", {"GitHub": "Git Hub"}) == "Git Hub"


def test_markup():
    items = parse("Hello there. [pause 600ms] [style serious] Careful now.\n\nNew paragraph.[pace 0.9] Slow.")
    kinds = [type(i).__name__ for i in items]
    assert kinds == ["Segment", "Pause", "Segment", "Pause", "Segment", "Segment"]
    assert items[1].ms == 600 and isinstance(items[1], Pause)
    assert items[2].style == "serious" and items[2].text == "Careful now."
    assert items[3].ms == 750
    assert items[5].pace == 0.9


def test_pause_units():
    assert parse("[pause 1.5s]")[0].ms == 1500
    assert parse("[pause 250]")[0].ms == 250


def test_chunker_merges_short_and_keeps_abbrev():
    assert split_sentences("Dr. Smith left. He came back.") == ["Dr. Smith left.", "He came back."]
    ch = make_chunks("Not spam. Drafts. Starting points are what these are, honestly speaking.")
    assert all(len(c) >= 20 for c in ch)
    assert make_chunks("a " * 400)  # long text is split, not dropped


def test_gaps_by_punctuation():
    assert gap_after_ms("Really...") > gap_after_ms("Yes.") > gap_after_ms("So,")
