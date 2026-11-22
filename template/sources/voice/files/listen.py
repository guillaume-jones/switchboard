"""Transcribes speech from a pseudo-terminal without storing it.

Input lines: base64 of 16 kHz mono s16le PCM, `.` once the recording ends, `q` to exit.
Output lines: JSON `ready`, then a `text` per stretch of speech as soon as it is transcribed, then `done`.
"""

import base64
import json
import math
import queue
import sys
import threading
from array import array

RATE = 16000
FRAME = RATE * 30 // 1000
# Whisper only applies the vocabulary to its first 30 s window, so longer speech is cut into shorter ones, after the last
# finished sentence, else at the quietest pause.
WINDOW = 28 * RATE
EARLIEST_CUT = 18 * RATE
PROMPT_TOKENS = 223


def emit(**message):
    print(json.dumps(message) + "\r", flush=True)


def loudness(pcm, size=FRAME):
    return [math.sqrt(sum(x * x for x in pcm[i : i + size]) / size) for i in range(0, len(pcm) - size + 1, size)]


def has_speech(pcm):
    """Whether loudness varies like speech, as Whisper invents words for silence and steady noise."""
    levels = sorted(loudness(pcm))
    if len(levels) < 5:
        return False
    quiet, loud = levels[len(levels) // 10], levels[len(levels) * 95 // 100]
    return loud > 0.003 and loud > quiet * 1.5


def quietest(pcm):
    size = FRAME * 10
    levels = loudness(pcm[EARLIEST_CUT:WINDOW], size)
    return EARLIEST_CUT + levels.index(min(levels)) * size + size // 2


def read(lines):
    for line in sys.stdin.buffer:
        line = line.strip()
        if line == b"q":
            break
        lines.put(line)
    lines.put(b"q")


def listen(lines, library_path, model_path, vocabulary_path):
    sys.path.insert(0, library_path)
    import transcribe_cpp

    model = transcribe_cpp.Model(model_path)
    session = model.session()
    with open(vocabulary_path) as file:
        terms = [term.strip() for term in file if term.strip()]
    # The closing full stop matters: without one Whisper copies the list's style and stops punctuating.
    while terms and len(model.tokenize(f" {', '.join(terms)}.")) > PROMPT_TOKENS:
        terms.pop()
    options = transcribe_cpp.WhisperRunOptions(initial_prompt=f" {', '.join(terms)}." if terms else None)

    def sentence_end(pcm):
        """The sample after the last finished sentence, if any. Only for cutting, as timestamps make the text worse."""
        if not has_speech(pcm):
            return None
        segments = session.run(pcm, language="en", family=options, timestamps="segment").segments
        # The last segment is left out: it runs into the end of the audio, where Whisper always ends the sentence.
        for segment, following in reversed(list(zip(segments, segments[1:]))):
            if segment.t1_ms and segment.text.rstrip().endswith((".", "?", "!")):
                return (segment.t1_ms + max(segment.t1_ms, following.t0_ms)) // 2 * RATE // 1000
        return None

    def transcribe(pcm):
        if has_speech(pcm):
            text = session.run(pcm, language="en", family=options).text.strip()
            if text:
                emit(text=text)

    emit(ready=True)
    pcm = array("f")
    while (line := lines.get()) != b"q":
        if line == b".":
            transcribe(pcm)
            emit(done=True)
            pcm = array("f")
        elif line:
            pcm.extend(sample / 32768 for sample in array("h", base64.b64decode(line)))
            while len(pcm) >= WINDOW:
                cut = sentence_end(pcm[:WINDOW]) or quietest(pcm)
                transcribe(pcm[:cut])
                pcm = pcm[cut:]


def main():
    lines = queue.Queue()
    threading.Thread(target=read, args=(lines,), daemon=True).start()
    try:
        listen(lines, *sys.argv[1:])
    except Exception as error:
        emit(error=f"Dictation failed: {error}")
        # Output still unread when the terminal closes is lost, so wait for the card to have read it.
        while lines.get() != b"q":
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
