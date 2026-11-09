"""FireVoice core: engine workers (one process per model copy, each in its own venv), the pool that
supervises them, and the scheduler that spreads sentence-level jobs across every worker so the GPU is
never idle.

    EnginePool ──spawns──> worker.py (venv A) ── adapter ── model copy 1
               ──spawns──> worker.py (venv A) ── adapter ── model copy 2
               ──spawns──> worker.py (venv B) ── adapter ── other model
    Scheduler  ──fans out chunks / candidate takes──> pool ──> results (float32 .npy via a scratch dir)
"""
