"""FireVoice: self-hosted expressive TTS toolkit."""
from .types import Word, Take, Result, Segment, Pause  # noqa: F401

__version__ = "2.0.2"
# The HTTP contract version. Bump it when a route or a response shape changes in a way an older client would misread;
# clients (the desktop app) compare it with the range they support. MIN_CLIENT_API is the oldest client contract this
# server still serves correctly.
# 3: dubbing, sound, separation, quality reports, watermark detection, engine installs, engines?task=
API_VERSION = 6
MIN_CLIENT_API = 1
