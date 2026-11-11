"""Dictated words to text: spoken punctuation, your replacements and snippets, corrections said out loud."""
import pytest

from firevoice.dictation_text import PhraseRules, backtrack, format_words, tidy

MINE = PhraseRules.build(
    replacements=[{"heard": "fire voice", "write": "FireVoice"}, {"heard": "wazeem", "write": "Waseem"}],
    snippets=[{"trigger": "my email", "text": "waseem@example.com"}, {"trigger": "sign off", "text": "Best,\nWaseem"}],
)


@pytest.mark.parametrize("said, text", [
    ("Dear Anna comma thanks for the notes full stop", "Dear Anna, thanks for the notes."),
    ("is it ready question mark", "is it ready?"),
    ("he said open quote hello close quote", "he said “hello”"),
    ("one colon two", "one: two"),
    ("we love fire voice", "we love FireVoice"),
    ("Thanks, wazeem.", "Thanks, Waseem"),
    ("write to my email please", "write to waseem@example.com please"),
    ("cheers sign off", "cheers Best,\nWaseem"),
    ("a comma b", "a, b"),
])
def test_phrases(said, text):
    assert format_words(said.split(), rules=MINE) == text


def test_the_first_words_of_a_phrase_wait_for_the_next_word_while_live():
    w = "please send it to my".split()
    assert format_words(w, rules=MINE, final=False) == "please send it to"           # "my" may start "my email"
    assert format_words(w + ["email"], rules=MINE, final=False) == "please send it to waseem@example.com"
    assert format_words(w + ["friend"], rules=MINE, final=False) == "please send it to my friend"
    assert format_words(["fire"], rules=MINE, final=False) == ""
    assert format_words(["fire"], rules=MINE, final=True) == "fire"


def test_live_text_only_ever_grows():
    said = "so um we should email fire voice support comma then sign off".split()
    prev = ""
    for i in range(1, len(said) + 1):
        now = format_words(said[:i], rules=MINE, final=False)
        assert now.startswith(prev), (prev, now)
        prev = now


def test_without_commands_nothing_is_converted():
    assert format_words("new line comma".split(), commands=False) == "new line comma"


@pytest.mark.parametrize("text, fixed", [
    ("Send it to Tom. Scratch that. Send it to Anna.", "Send it to Anna."),
    ("Let's meet on Tuesday, no wait, Friday at noon.", "Let's meet on Friday at noon."),
    ("Book a table for four. Sorry, I meant a table for five.", "Book a table for five."),
    ("The report is due at 5pm, no wait, at 6pm.", "The report is due at 6pm."),
    ("I think we should go home, no wait, we should stay and finish the slides tonight.",
     "I think we should stay and finish the slides tonight."),
    ("We need milk, eggs, no wait, bread.", "We need milk, bread."),
    ("Call John at three, no wait, at four.", "Call John at four."),
    ("Hi Sam, sorry I meant Sarah, how are you?", "Hi Sarah, how are you?"),
    ("So um, I was thinking we could meet on Tuesday. No wait, Friday at three, to go over the budget.",
     "So um, I was thinking we could meet on Friday at three, to go over the budget."),
    ("We could go home, no wait, let's stay a bit longer.", "Let's stay a bit longer."),
    ("Nothing to fix here.", "Nothing to fix here."),
    ("I mean it, this is great.", "I mean it, this is great."),               # "I mean" alone is ordinary speech
])
def test_backtrack(text, fixed):
    assert backtrack(text) == fixed


def test_tidy():
    assert tidy("hello  world .  next one , ok") == "Hello world. Next one, ok"
