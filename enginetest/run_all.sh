#!/bin/bash
# Builds the native engine for this machine and checks it against the web engine on every scenario.
set -e; cd "$(dirname "$0")"; S="${TMPDIR:-/tmp}/nc333-enginetest"; mkdir -p "$S"
g++ -std=c++17 -O2 -w run_cpp.cpp ../app/src/main/cpp/engine/GrainEngine.cpp -o "$S/run_cpp"
node run_js.js --sample "$S/sample.f32"
fail=0
for f in scenarios/*.txt; do n=$(basename "$f" .txt)
  node run_js.js "$f" "$S/sample.f32" "$S/$n.js.f32" >/dev/null
  t0=$(date +%s%N); "$S/run_cpp" "$f" "$S/sample.f32" "$S/$n.cpp.f32" >/dev/null; t1=$(date +%s%N)
  printf "%-18s native %4d ms  " "$n" $(( (t1-t0)/1000000 )); node compare.js "$S/$n.js.f32" "$S/$n.cpp.f32" || fail=1
done
exit $fail
