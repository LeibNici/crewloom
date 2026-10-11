/**
 * `zxing-wasm/reader/zxing_reader.wasm` 的占位模块（原生组件最小集成，公共负责人维护）。
 *
 * 背景（实测，不是猜测）：`@nocobase/client-v2@2.2.22` 的 ESM 产物里对
 * `zxing-wasm/dist/reader/zxing_reader.wasm` 做了裸 `.wasm` 动态 import（移动端扫码）。
 * Vite 7 不支持 "ESM integration proposal for Wasm"，构建会直接失败：
 *   [vite:wasm-fallback] Could not load .../zxing_reader.wasm
 *   "ESM integration proposal for Wasm" is not supported currently.
 * 归档实验 experiments/native-canvas-source 用的是同一个占位做法。
 *
 * 本产品当前不使用扫码，因此这里只替换这个动态入口；它**不**改变任何其它原生实现。
 * 真正需要扫码时，应改用 `vite-plugin-wasm` 或 `.wasm?init`，而不是继续用占位。
 */
export default null;
