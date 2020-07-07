import fs from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import camelCase from 'camelcase';
import escapeStringRegexp from 'escape-string-regexp';
import { blue } from 'kleur';
import { map } from 'asyncro';
import glob from 'tiny-glob/sync';
import autoprefixer from 'autoprefixer';
import cssnano from 'cssnano';
import { rollup, watch } from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import customBabel from './lib/babel-custom';
import nodeResolve from '@rollup/plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';
import alias from '@rollup/plugin-alias';
import postcss from 'rollup-plugin-postcss';
import typescript from 'rollup-plugin-typescript2';
import json from '@rollup/plugin-json';
import logError from './log-error';
import { isDir, isFile, stdout, isTruthy, removeScope } from './utils';
import { getSizeInfo } from './lib/compressed-size';
import { normalizeMinifyOptions } from './lib/terser';
import {
	parseAliasArgument,
	parseExternals,
	parseMappingArgument,
	toReplacementExpression,
} from './lib/option-normalization';
import { getConfigFromPkgJson, getName } from './lib/package-info';
import { shouldCssModules, cssModulesConfig } from './lib/css-modules';

// Extensions to use when resolving modules
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.es6', '.es', '.mjs'];

const WATCH_OPTS = {
	exclude: 'node_modules/**',
};

export default async function microbundle(inputOptions) {
	let options = { ...inputOptions };

	options.cwd = resolve(process.cwd(), inputOptions.cwd);
	const cwd = options.cwd;

	const { hasPackageJson, pkg } = await getConfigFromPkgJson(cwd);
	options.pkg = pkg;

	const { finalName, pkgName } = getName({
		name: options.name,
		pkgName: options.pkg.name,
		amdName: options.pkg.amdName,
		hasPackageJson,
		cwd,
	});

	options.name = finalName;
	options.pkg.name = pkgName;

	if (options.sourcemap !== false) {
		options.sourcemap = true;
	}

	options.input = await getInput({
		entries: options.entries,
		cwd,
		source: options.pkg.source,
		module: options.pkg.module,
	});

	options.output = await getOutput({
		cwd,
		output: options.output,
		pkgMain: options.pkg.main,
		pkgName: options.pkg.name,
	});

	options.entries = await getEntries({
		cwd,
		input: options.input,
	});

	// options.multipleEntries = options.entries.length > 1;
	options.multipleEntries = false;

	let formats = (options.format || options.formats).split(',');
	// always compile cjs first if it's there:
	formats.sort((a, b) => (a === 'cjs' ? -1 : a > b ? 1 : 0));

	const bundle = await rollup(getConfigInput(options));

	let steps = [];
	// for (let i = 0; i < options.entries.length; i++) {
	// for (let j = 0; j < formats.length; j++) {
	// 	steps.push(createConfig(options, options.entries[0], formats[j], j === 0));
	// }
	// }

	if (options.watch) {
		return doWatch(options, cwd, steps);
	}

	let out = [];
	for (let i = 0; i < formats.length; i++) {
		const { output } = await bundle.write(
			getConfigOutput(options, formats[i], i === 0),
		);

		out.push(
			await Promise.all(
				output.map(({ code, fileName }) => {
					if (code) {
						return getSizeInfo(code, fileName, options.raw);
					}
				}),
			).then(results => results.filter(Boolean).join('\n')),
		);
	}
	// );

	const targetDir = relative(cwd, dirname(options.output)) || '.';
	const banner = blue(`Build "${options.name}" to ${targetDir}:`);
	return {
		output: `${banner}\n   ${out.join('\n   ')}`,
	};
}

function doWatch(options, cwd, steps) {
	const { onStart, onBuild, onError } = options;

	return new Promise((resolve, reject) => {
		const targetDir = relative(cwd, dirname(options.output));
		stdout(blue(`Watching source, compiling to ${targetDir}:`));

		const watchers = steps.reduce((acc, options) => {
			acc[options.inputOptions.input] = watch(
				Object.assign(
					{
						output: options.outputOptions,
						watch: WATCH_OPTS,
					},
					options.inputOptions,
				),
			).on('event', e => {
				if (e.code === 'START') {
					if (typeof onStart === 'function') {
						onStart(e);
					}
				}
				if (e.code === 'ERROR') {
					logError(e.error);
					if (typeof onError === 'function') {
						onError(e);
					}
				}
				if (e.code === 'END') {
					options._sizeInfo.then(text => {
						stdout(`Wrote ${text.trim()}`);
					});
					if (typeof onBuild === 'function') {
						onBuild(e);
					}
				}
			});

			return acc;
		}, {});

		resolve({ watchers });
	});
}

async function jsOrTs(cwd, filename) {
	const extension = (await isFile(resolve(cwd, filename + '.ts')))
		? '.ts'
		: (await isFile(resolve(cwd, filename + '.tsx')))
		? '.tsx'
		: '.js';

	return resolve(cwd, `${filename}${extension}`);
}

async function getInput({ entries, cwd, source, module }) {
	const input = [];

	[]
		.concat(
			entries && entries.length
				? entries
				: (source &&
						(Array.isArray(source) ? source : [source]).map(file =>
							resolve(cwd, file),
						)) ||
						((await isDir(resolve(cwd, 'src'))) &&
							(await jsOrTs(cwd, 'src/index'))) ||
						(await jsOrTs(cwd, 'index')) ||
						module,
		)
		.map(file => glob(file))
		.forEach(file => input.push(...file));

	return input;
}

async function getOutput({ cwd, output, pkgMain, pkgName }) {
	let main = resolve(cwd, output || pkgMain || 'dist');
	if (!main.match(/\.[a-z]+$/) || (await isDir(main))) {
		main = resolve(main, `${removeScope(pkgName)}.js`);
	}
	return main;
}

function getDeclarationDir({ options, pkg }) {
	const { cwd, output } = options;

	let result = output;

	if (pkg.types || pkg.typings) {
		result = pkg.types || pkg.typings;
		result = resolve(cwd, result);
	}

	result = dirname(result);

	return result;
}

async function getEntries({ input, cwd }) {
	let entries = (
		await map([].concat(input), async file => {
			file = resolve(cwd, file);
			if (await isDir(file)) {
				file = resolve(file, 'index.js');
			}
			return file;
		})
	).filter((item, i, arr) => arr.indexOf(item) === i);
	return entries;
}

function replaceName(filename, name) {
	return resolve(
		dirname(filename),
		name + basename(filename).replace(/^[^.]+/, ''),
	);
}

function getMain({ options, entry, format }) {
	const { pkg } = options;
	const pkgMain = options['pkg-main'];

	if (!pkgMain) {
		return options.output;
	}

	let mainNoExtension = options.output;
	// if (options.multipleEntries) {
	let name = entry.match(/([\\/])index(\.(umd|cjs|es|m))?\.(mjs|[tj]sx?)$/)
		? mainNoExtension
		: entry;
	mainNoExtension = resolve(dirname(mainNoExtension), basename(name));
	// }
	mainNoExtension = mainNoExtension.replace(
		/(\.(umd|cjs|es|m))?\.(mjs|[tj]sx?)$/,
		'',
	);

	const mainsByFormat = {};

	mainsByFormat.es = replaceName(
		pkg.module && !pkg.module.match(/src\//)
			? pkg.module
			: pkg['jsnext:main'] || 'x.esm.js',
		mainNoExtension,
	);
	mainsByFormat.modern = replaceName(
		(pkg.syntax && pkg.syntax.esmodules) || pkg.esmodule || 'x.modern.js',
		mainNoExtension,
	);
	mainsByFormat.cjs = replaceName(pkg['cjs:main'] || 'x.js', mainNoExtension);
	mainsByFormat.umd = replaceName(
		pkg['umd:main'] || 'x.umd.js',
		mainNoExtension,
	);

	return mainsByFormat[format] || mainsByFormat.cjs;
}

// shebang cache map because the transform only gets run once
const shebang = {};

function getConfigInput(options) {
	const { pkg } = options;

	const moduleAliases = options.alias ? parseAliasArgument(options.alias) : [];
	const aliasIds = moduleAliases.map(alias => alias.find);

	const useTypescript = options.entries.some(entry => {
		const ext = extname(entry);
		return ext === '.ts' || ext === '.tsx';
	});

	const external = /** @type {Array<string|RegExp>} */ ([
		'dns',
		'fs',
		'path',
		'url',
	])
		.concat(options.entries)
		.concat(
			parseExternals(options.external, pkg.peerDependencies, pkg.dependencies),
		);

	const escapeStringExternals = ext =>
		ext instanceof RegExp ? ext.source : escapeStringRegexp(ext);
	const externalPredicate = new RegExp(
		`^(${external.map(escapeStringExternals).join('|')})($|/)`,
	);
	const externalTest =
		external.length === 0 ? id => false : id => externalPredicate.test(id);

	/** @type {import('rollup').InputOptions} */
	const config = {
		input: options.entries.reduce((acc, entry) => {
			acc[
				basename(getMain({ options, entry, format: 'cjs' })).replace('.js', '')
			] = entry;

			return acc;
		}, {}),
		external: id => {
			// include async-to-promises helper once inside the bundle
			if (id === 'babel-plugin-transform-async-to-promises/helpers') {
				return false;
			}

			// Mark other entries as external so they don't get bundled
			if (options.multipleEntries && id === '.') {
				return true;
			}

			if (aliasIds.indexOf(id) >= 0) {
				return false;
			}
			return externalTest(id);
		},
		treeshake: {
			propertyReadSideEffects: false,
		},
		plugins: [
			postcss({
				autoModules: shouldCssModules(options),
				modules: cssModulesConfig(options),
				// only write out CSS for the first bundle (avoids pointless extra files):
				inject: false,
				extract: false,
			}),
			moduleAliases.length > 0 &&
				alias({
					// @TODO: this is no longer supported, but didn't appear to be required?
					// resolve: EXTENSIONS,
					entries: moduleAliases,
				}),
			nodeResolve({
				mainFields: ['module', 'jsnext', 'main'],
				browser: options.target !== 'node',
				// defaults + .jsx
				extensions: ['.mjs', '.js', '.jsx', '.json', '.node'],
				preferBuiltins: options.target === 'node',
			}),
			commonjs({
				// use a regex to make sure to include eventual hoisted packages
				include: /\/node_modules\//,
			}),
			json(),
			customBabel()({
				babelHelpers: 'bundled',
				extensions: EXTENSIONS,
				exclude: 'node_modules/**',
				passPerPreset: true, // @see https://babeljs.io/docs/en/options#passperpreset
				custom: {
					// defines,
					// modern,
					compress: options.compress !== false,
					targets: options.target === 'node' ? { node: '8' } : undefined,
					pragma: options.jsx || 'h',
					pragmaFrag: options.jsxFragment || 'Fragment',
					typescript: !!useTypescript,
				},
			}),
			useTypescript &&
				typescript({
					typescript: require('typescript'),
					cacheRoot: `./node_modules/.cache/.rts2_cache`,
					useTsconfigDeclarationDir: true,
					tsconfigDefaults: {
						compilerOptions: {
							sourceMap: options.sourcemap,
							declaration: true,
							declarationDir: getDeclarationDir({ options, pkg }),
							jsx: 'react',
							jsxFactory:
								// TypeScript fails to resolve Fragments when jsxFactory
								// is set, even when it's the same as the default value.
								options.jsx === 'React.createElement'
									? undefined
									: options.jsx || 'h',
						},
						files: options.entries,
					},
					tsconfig: options.tsconfig,
					tsconfigOverride: {
						compilerOptions: {
							module: 'ESNext',
							target: 'esnext',
						},
					},
				}),
			{
				// We have to remove shebang so it doesn't end up in the middle of the code somewhere
				transform: code => ({
					code: code.replace(/^#![^\n]*/, bang => {
						shebang[options.name] = bang;
					}),
					map: null,
				}),
			},
		],
	};

	return config;
}

function getConfigOutput(options, format, writeMeta) {
	const isModern = format === 'modern';

	const absMain = resolve(
		options.cwd,
		getMain({ options, entry: options.entries[0], format }),
	);
	const outputDir = dirname(absMain);

	/** @type {Record<string, string>} */
	let outputAliases = {};
	// since we transform src/index.js, we need to rename imports for it:
	if (options.multipleEntries) {
		outputAliases['.'] = './' + basename(options.output);
	}

	return {
		paths: outputAliases,
		// globals,
		strict: options.strict === true,
		freeze: false,
		esModule: false,
		sourcemap: options.sourcemap,
		get banner() {
			return shebang[options.name];
		},
		format: isModern ? 'es' : format,
		name: options.name,
		dir: outputDir,
		entryFileNames: '[name].js',
	};
}

function createConfig(options, entry, format, writeMeta) {
	let { pkg } = options;

	const external = /** @type {Array<string|RegExp>} */ ([
		'dns',
		'fs',
		'path',
		'url',
	])
		.concat(options.entries.filter(e => e !== entry))
		.concat(
			parseExternals(options.external, pkg.peerDependencies, pkg.dependencies),
		);

	/** @type {Record<string, string>} */
	let outputAliases = {};
	// since we transform src/index.js, we need to rename imports for it:
	if (options.multipleEntries) {
		outputAliases['.'] = './' + basename(options.output);
	}

	const moduleAliases = options.alias ? parseAliasArgument(options.alias) : [];
	const aliasIds = moduleAliases.map(alias => alias.find);

	let globals = external.reduce((globals, name) => {
		// Use raw value for CLI-provided RegExp externals:
		if (name instanceof RegExp) name = name.source;

		// valid JS identifiers are usually library globals:
		if (name.match(/^[a-z_$][a-z0-9_\-$]*$/)) {
			globals[name] = camelCase(name);
		}
		return globals;
	}, {});
	if (options.globals && options.globals !== 'none') {
		globals = Object.assign(globals, parseMappingArgument(options.globals));
	}

	let defines = {};
	if (options.define) {
		defines = Object.assign(
			defines,
			parseMappingArgument(options.define, toReplacementExpression),
		);
	}

	const modern = format === 'modern';

	// let rollupName = safeVariableName(basename(entry).replace(/\.js$/, ''));

	let nameCache = {};
	const bareNameCache = nameCache;
	// Support "minify" field and legacy "mangle" field via package.json:
	const rawMinifyValue = options.pkg.minify || options.pkg.mangle || {};
	let minifyOptions = typeof rawMinifyValue === 'string' ? {} : rawMinifyValue;
	const getNameCachePath =
		typeof rawMinifyValue === 'string'
			? () => resolve(options.cwd, rawMinifyValue)
			: () => resolve(options.cwd, 'mangle.json');

	const useTypescript = extname(entry) === '.ts' || extname(entry) === '.tsx';

	const escapeStringExternals = ext =>
		ext instanceof RegExp ? ext.source : escapeStringRegexp(ext);
	const externalPredicate = new RegExp(
		`^(${external.map(escapeStringExternals).join('|')})($|/)`,
	);
	const externalTest =
		external.length === 0 ? id => false : id => externalPredicate.test(id);

	function loadNameCache() {
		try {
			nameCache = JSON.parse(fs.readFileSync(getNameCachePath(), 'utf8'));
			// mangle.json can contain a "minify" field, same format as the pkg.mangle:
			if (nameCache.minify) {
				minifyOptions = Object.assign(
					{},
					minifyOptions || {},
					nameCache.minify,
				);
			}
		} catch (e) {}
	}
	loadNameCache();

	normalizeMinifyOptions(minifyOptions);

	if (nameCache === bareNameCache) nameCache = null;

	/** @type {false | import('rollup').RollupCache} */
	let cache;
	if (modern) cache = false;

	const absMain = resolve(options.cwd, getMain({ options, entry, format }));
	const outputDir = dirname(absMain);
	const outputEntryFileName = basename(absMain);

	let config = {
		/** @type {import('rollup').InputOptions} */
		inputOptions: {
			// disable Rollup's cache for the modern build to prevent re-use of legacy transpiled modules:
			cache,

			input: entry,
			external: id => {
				if (id === 'babel-plugin-transform-async-to-promises/helpers') {
					return false;
				}
				if (options.multipleEntries && id === '.') {
					return true;
				}
				if (aliasIds.indexOf(id) >= 0) {
					return false;
				}
				return externalTest(id);
			},
			treeshake: {
				propertyReadSideEffects: false,
			},
			plugins: []
				.concat(
					postcss({
						plugins: [
							autoprefixer(),
							options.compress !== false &&
								cssnano({
									preset: 'default',
								}),
						].filter(Boolean),
						autoModules: shouldCssModules(options),
						modules: cssModulesConfig(options),
						// only write out CSS for the first bundle (avoids pointless extra files):
						inject: false,
						extract: !!writeMeta,
					}),
					moduleAliases.length > 0 &&
						alias({
							// @TODO: this is no longer supported, but didn't appear to be required?
							// resolve: EXTENSIONS,
							entries: moduleAliases,
						}),
					nodeResolve({
						mainFields: ['module', 'jsnext', 'main'],
						browser: options.target !== 'node',
						// defaults + .jsx
						extensions: ['.mjs', '.js', '.jsx', '.json', '.node'],
						preferBuiltins: options.target === 'node',
					}),
					commonjs({
						// use a regex to make sure to include eventual hoisted packages
						include: /\/node_modules\//,
					}),
					json(),
					{
						// We have to remove shebang so it doesn't end up in the middle of the code somewhere
						transform: code => ({
							code: code.replace(/^#![^\n]*/, bang => {
								shebang[options.name] = bang;
							}),
							map: null,
						}),
					},
					// if defines is not set, we shouldn't run babel through node_modules
					isTruthy(defines) &&
						babel({
							babelHelpers: 'bundled',
							babelrc: false,
							compact: false,
							configFile: false,
							include: 'node_modules/**',
							plugins: [
								[
									require.resolve('babel-plugin-transform-replace-expressions'),
									{ replace: defines },
								],
							],
						}),
					customBabel()({
						babelHelpers: 'bundled',
						extensions: EXTENSIONS,
						exclude: 'node_modules/**',
						passPerPreset: true, // @see https://babeljs.io/docs/en/options#passperpreset
						custom: {
							defines,
							modern,
							compress: options.compress !== false,
							targets: options.target === 'node' ? { node: '8' } : undefined,
							pragma: options.jsx || 'h',
							pragmaFrag: options.jsxFragment || 'Fragment',
							typescript: !!useTypescript,
						},
					}),
					options.compress !== false && [
						terser({
							sourcemap: true,
							compress: Object.assign(
								{
									keep_infinity: true,
									pure_getters: true,
									// Ideally we'd just get Terser to respect existing Arrow functions...
									// unsafe_arrows: true,
									passes: 10,
								},
								minifyOptions.compress || {},
							),
							output: {
								// By default, Terser wraps function arguments in extra parens to trigger eager parsing.
								// Whether this is a good idea is way too specific to guess, so we optimize for size by default:
								wrap_func_args: false,
								comments: false,
							},
							warnings: true,
							ecma: modern ? 9 : 5,
							toplevel: modern || format === 'cjs' || format === 'es',
							mangle: Object.assign({}, minifyOptions.mangle || {}),
							nameCache,
						}),
						nameCache && {
							// before hook
							options: loadNameCache,
							// after hook
							writeBundle() {
								if (writeMeta && nameCache) {
									fs.writeFile(
										getNameCachePath(),
										JSON.stringify(nameCache, null, 2),
										() => {},
									);
								}
							},
						},
					],
				)
				.filter(Boolean),
		},

		/** @type {import('rollup').OutputOptions} */
		outputOptions: {
			paths: outputAliases,
			globals,
			strict: options.strict === true,
			freeze: false,
			esModule: false,
			sourcemap: options.sourcemap,
			get banner() {
				return shebang[options.name];
			},
			format: modern ? 'es' : format,
			name: options.name,
			dir: outputDir,
			entryFileNames: outputEntryFileName,
		},
	};

	return config;
}
