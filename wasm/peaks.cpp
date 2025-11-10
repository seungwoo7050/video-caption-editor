#include <algorithm>
#include <cstdint>

extern "C" {
// Computes min/max peaks for the provided samples. The output buffer must have
// a length of `buckets * 2`, laid out as [min0, max0, min1, max1, ...].
void compute_peaks(const float* samples, int len, int buckets, int16_t* outMinMax) {
  if (!samples || !outMinMax || len <= 0 || buckets <= 0) {
    return;
  }

  const double samplesPerBucket = static_cast<double>(len) / static_cast<double>(buckets);

  for (int bucket = 0; bucket < buckets; ++bucket) {
    const int startIndex = static_cast<int>(bucket * samplesPerBucket);
    int endIndex = static_cast<int>((bucket + 1) * samplesPerBucket);
    if (endIndex <= startIndex) {
      endIndex = startIndex + 1;
    }
    if (endIndex > len) {
      endIndex = len;
    }

    float minVal = 1.0f;
    float maxVal = -1.0f;
    for (int i = startIndex; i < endIndex; ++i) {
      const float value = samples[i];
      if (value < minVal) minVal = value;
      if (value > maxVal) maxVal = value;
    }

    const int32_t scaledMin = static_cast<int32_t>(minVal * 32768.0f);
    const int32_t scaledMax = static_cast<int32_t>(maxVal * 32767.0f);

    outMinMax[bucket * 2] = static_cast<int16_t>(std::min<int32_t>(32767, std::max<int32_t>(-32768, scaledMin)));
    outMinMax[bucket * 2 + 1] = static_cast<int16_t>(std::min<int32_t>(32767, std::max<int32_t>(-32768, scaledMax)));
  }
}
}
