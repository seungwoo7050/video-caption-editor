(module
  (memory (export "memory") 4)
  (global (export "__heap_base") i32 (i32.const 0))
  (func (export "compute_peaks") (param $samples i32) (param $len i32) (param $buckets i32) (param $out i32)
    (local $bucket i32)
    (local $start i32)
    (local $end i32)
    (local $index i32)
    (local $min f32)
    (local $max f32)
    (local $samplesPerBucket f32)
    (if (i32.le_s (local.get $len) (i32.const 0)) (then (return)))
    (if (i32.le_s (local.get $buckets) (i32.const 0)) (then (return)))
    (local.set $samplesPerBucket
      (f32.div (f32.convert_i32_s (local.get $len)) (f32.convert_i32_s (local.get $buckets))))
    (local.set $bucket (i32.const 0))
    (block $bucket_done
      (loop $bucket_loop
        (br_if $bucket_done (i32.ge_s (local.get $bucket) (local.get $buckets)))
        (local.set $start
          (i32.trunc_f32_s (f32.mul (f32.convert_i32_s (local.get $bucket)) (local.get $samplesPerBucket))))
        (local.set $end
          (i32.trunc_f32_s (f32.mul (f32.convert_i32_s (i32.add (local.get $bucket) (i32.const 1))) (local.get $samplesPerBucket))))
        (if (i32.le_s (local.get $end) (local.get $start))
          (then (local.set $end (i32.add (local.get $start) (i32.const 1)))))
        (if (i32.gt_s (local.get $end) (local.get $len)) (then (local.set $end (local.get $len))))
        (local.set $min (f32.const 1))
        (local.set $max (f32.const -1))
        (local.set $index (local.get $start))
        (block $samples_done
          (loop $sample_loop
            (br_if $samples_done (i32.ge_s (local.get $index) (local.get $end)))
            (local.set $min
              (f32.min (local.get $min)
                (f32.load (i32.add (local.get $samples) (i32.shl (local.get $index) (i32.const 2))))))
            (local.set $max
              (f32.max (local.get $max)
                (f32.load (i32.add (local.get $samples) (i32.shl (local.get $index) (i32.const 2))))))
            (local.set $index (i32.add (local.get $index) (i32.const 1)))
            (br $sample_loop)
          )
        )
        (i32.store16
          (i32.add (local.get $out) (i32.shl (local.get $bucket) (i32.const 2)))
          (i32.trunc_sat_f32_s (f32.min (f32.const 32767) (f32.max (f32.const -32768) (f32.mul (local.get $min) (f32.const 32768))))))
        (i32.store16
          (i32.add (local.get $out) (i32.add (i32.shl (local.get $bucket) (i32.const 2)) (i32.const 2)))
          (i32.trunc_sat_f32_s (f32.min (f32.const 32767) (f32.max (f32.const -32768) (f32.mul (local.get $max) (f32.const 32767))))))
        (local.set $bucket (i32.add (local.get $bucket) (i32.const 1)))
        (br $bucket_loop)
      )
    )
  )
)
