"""Diagnostic: list render devices, loopbacks, and current defaults."""
import pyaudiowpatch as pyaudio

p = pyaudio.PyAudio()
wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
print(f"default output device index: {wasapi['defaultOutputDevice']}")
print(f"default input device index:  {wasapi['defaultInputDevice']}\n")

for i in range(p.get_device_count()):
    d = p.get_device_info_by_index(i)
    if d["hostApi"] != wasapi["index"]:
        continue
    kind = "LOOPBACK" if d.get("isLoopbackDevice") else ("out" if d["maxOutputChannels"] else "in ")
    print(f"[{i:3}] {kind:8} rate={int(d['defaultSampleRate']):6} ch_in={d['maxInputChannels']} {d['name']}")
