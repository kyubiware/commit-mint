declare module "picomatch" {
	interface PicomatchOptions {
		dot?: boolean;
		matchBase?: boolean;
		posixSlashes?: boolean;
		strictBrackets?: boolean;
	}

	type MatchFunction = (value: string) => boolean;

	function picomatch(pattern: string, options?: PicomatchOptions): MatchFunction;

	export default picomatch;
}
