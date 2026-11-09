"""Automated listening test for a rendered showcase (samples/<engine>/index.json).

Stages (each resumable, results cached next to the samples in judge/):
  manifest    clips.json: every clip with the text it should say, its language, its original reference clip and the
              comparison groups it belongs to (same text, different voice / setting)
  metrics     (main venv) Whisper intelligibility, similarity to the original voice, prosody liveliness
  listen      (judge venv) UTMOSv2 naturalness MOS, emotion2vec+ emotion classes, arousal / valence / dominance
  tournament  (judge venv) SpeechJudge-GRM, a Qwen2.5-Omni judge trained on 99K human A/B naturalness votes, listens
              to pairs of clips with the same text, scores both 1-10 and explains why; Swiss-system rounds give an
              arena rating per voice, per style and per setting
  report      ranked lists (most realistic voices, best voice per style, strongest styles, clone modes, Urdu,
              languages, knobs, designed voices) as report.html + report.md + report.json
"""
