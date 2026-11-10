import json

TEXT = "The resolver asks the root first. Then it asks the top level domain. Finally it asks the authority."


def test_second_call_hits_cache_and_matches(make):
    s = make(cache=True)
    r1 = s.speak(TEXT, lufs=None)
    assert s.cache_hits == 0 and s.cache_misses == len(r1.takes) == 3
    assert not any(t.cached for t in r1.takes)
    r2 = s.speak(TEXT, lufs=None)
    assert s.cache_hits == 3 and s.cache_misses == 3
    assert all(t.cached for t in r2.takes)
    assert r2.duration == r1.duration
    assert [(w.text, round(w.start, 4), round(w.end, 4)) for w in r2.words] == [(w.text, round(w.start, 4), round(w.end, 4)) for w in r1.words]
    assert (r2.audio == r1.audio).all()


def test_one_word_change_misses_only_that_sentence(make):
    s = make(cache=True)
    s.speak(TEXT, lufs=None)
    s.cache_hits = s.cache_misses = 0
    r = s.speak(TEXT.replace("top level domain", "top level zone"), lufs=None)
    assert s.cache_hits == 2 and s.cache_misses == 1
    assert [t.cached for t in r.takes] == [True, False, True]


def test_style_pace_seed_and_voice_are_part_of_the_key(make):
    s = make(cache=True)
    s.speak(TEXT, lufs=None)
    s.cache_hits = s.cache_misses = 0
    s.speak(TEXT, style="excited", lufs=None)
    s.speak(TEXT, pace=1.1, lufs=None)
    s.speak(TEXT, seed=99, lufs=None)
    assert s.cache_hits == 0 and s.cache_misses == 9


def test_cache_files_are_on_disk_and_survive_a_new_synthesizer(make, tmp_path):
    s = make(cache=True)
    s.speak(TEXT, lufs=None)
    files = list((tmp_path / "cache").rglob("*.json"))
    assert len(files) == 3
    m = json.loads(files[0].read_text(encoding="utf-8"))
    assert "words" in m and "take" in m and m["take"]["cached"] is False
    s2 = make(cache=True)
    s2.speak(TEXT, lufs=None)
    assert s2.cache_hits == 3 and s2.cache_misses == 0


def test_no_cache_dir_means_no_cache(make, tmp_path):
    s = make(cache=False)
    s.speak(TEXT, lufs=None)
    s.speak(TEXT, lufs=None)
    assert s.cache_hits == 0 and s.cache_misses == 0 and not (tmp_path / "cache").exists()
