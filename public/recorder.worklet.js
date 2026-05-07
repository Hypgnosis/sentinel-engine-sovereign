class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      // Collect audio data up to bufferSize, then post it.
      for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bytesWritten++] = channelData[i];
        if (this.bytesWritten >= this.bufferSize) {
          // Send a copy to the main thread
          this.port.postMessage(Float32Array.from(this.buffer));
          this.bytesWritten = 0;
        }
      }
    }
    // Returning true keeps the processor alive.
    return true;
  }
}

registerProcessor('recorder.worklet', RecorderProcessor);
