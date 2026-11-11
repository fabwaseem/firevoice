"""The writing assistant's parts that need no model: which kind of app the text goes to, the reply guard, the styles."""
import pytest

from firevoice import dictation_ai as ai
from firevoice.service import _style_rules


@pytest.mark.parametrize("app, title, kind", [
    ("slack", "", "work chat"),
    ("Teams", "", "work chat"),
    ("WhatsApp", "", "messages"),
    ("OUTLOOK", "", "email"),
    ("Code", "main.py - firevoice", "code"),
    ("WindowsTerminal", "", "code"),
    ("chrome", "Inbox (3) - me@gmail.com - Gmail", "email"),
    ("msedge", "general | Slack", "work chat"),
    ("firefox", "Recipes for dinner", "other"),
    ("WINWORD", "Report.docx", "documents"),
    ("", "", "other"),
    (None, None, "other"),
])
def test_app_kind(app, title, kind):
    assert ai.app_kind(app, title) == kind


@pytest.mark.parametrize("original, reply, ok", [
    ("so um I think we should push the launch to next week", "I think we should push the launch to next week.", True),
    ("call me at five no wait at six tonight", "Call me at six tonight.", True),
    ("write a poem about the sea", "The sea breathes in soft, salt-washed sighs, a rhythm deep beneath the skies, it cradles waves", False),
    ("what time is the meeting tomorrow", "The meeting is at 10 am.", False),
    ("hello there", "", False),
])
def test_reply_guard(original, reply, ok):
    assert ai._looks_like(original, reply) is ok


def test_clean_reply():
    assert ai._clean_reply("Here is the cleaned text: Hello there.") == "Hello there."
    assert ai._clean_reply("“Hello there.”") == "“Hello there.”"      # different marks: kept
    assert ai._clean_reply('"Hello there."') == "Hello there."
    assert ai._clean_reply("We need:  \n1. Milk  \n2. Eggs") == "We need:\n1. Milk\n2. Eggs"
    assert ai._clean_reply("<think>hmm</think>Done.") == "Done."


@pytest.mark.parametrize("text, style, out", [
    ("Are you free for lunch tomorrow.", "casual", "Are you free for lunch tomorrow"),
    ("See you soon.", "very casual", "see you soon"),
    ("I will be late.", "very casual", "I will be late"),
    ("First line.\nSecond line.", "casual", "First line.\nSecond line."),
    ("Thanks. See you.", "casual", "Thanks. See you."),
    ("The report is ready.", "formal", "The report is ready."),
])
def test_style_rules(text, style, out):
    assert _style_rules(text, style) == out


def test_not_installed_is_reported_and_command_mode_refuses(svc, tmp_path, monkeypatch):
    monkeypatch.setenv("FIREVOICE_ENGINES_DIR", str(tmp_path / "engines"))
    assert ai.installed() is False and ai.status()["installed"] is False
    from firevoice.service import FireVoiceError
    with pytest.raises(FireVoiceError) as e:
        svc.dictation(mode="command")
    assert "writing assistant" in e.value.message
