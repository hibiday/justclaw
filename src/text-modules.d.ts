// Bun supports importing files as text via `with { type: "text" }`. Declare the
// module shape so `tsc` resolves these imports (the runtime handles them).
declare module "*.md" {
	const content: string;
	export default content;
}
