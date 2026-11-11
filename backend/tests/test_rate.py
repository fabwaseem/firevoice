"""Download progress text: amounts, speed, time left."""
from firevoice import rate


def test_progress_text(monkeypatch):
    t = [100.0]
    monkeypatch.setattr(rate.time, "monotonic", lambda: t[0])
    m = rate.Speedometer("Downloading Flare")
    assert m.text(0, 2.5e9) == "0 KB of 2.5 GB"            # no speed yet
    t[0] += 2
    assert m.text(10e6, 2.5e9) == "10 MB of 2.5 GB \u00b7 5.0 MB/s \u00b7 about 8 min left"
    t[0] += 1
    assert "MB/s" in m.text(12e6, 2.5e9)


def test_sizes_and_times():
    assert rate.size(312e6) == "312 MB" and rate.size(2.5e9) == "2.5 GB" and rate.size(900) == "1 KB"
    assert rate.eta(30) == "less than a minute left" and rate.eta(600) == "about 10 min left" and rate.eta(7200) == "about 2.0 h left"


def test_a_resumed_download_is_not_counted_as_speed(monkeypatch):
    t = [0.0]
    monkeypatch.setattr(rate.time, "monotonic", lambda: t[0])
    m = rate.Speedometer("x")
    m.text(38e6, 2.5e9)
    t[0] += 0.5
    m.rebase(238e6)                     # 200 MB were already on disk
    t[0] += 2
    assert "1.0 MB/s" in m.text(240e6, 2.5e9)
