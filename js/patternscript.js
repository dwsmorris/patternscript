var babel = require('systemjs-babel-build').babel;

// the SystemJS babel build includes standard presets
var es2015 = require('systemjs-babel-build').presetES2015;
var es2015Register = require('systemjs-babel-build').presetES2015Register;
var modulesRegister = require('systemjs-babel-build').modulesRegister;
var stage3 = require('systemjs-babel-build').pluginsStage3;
var stage2 = require('systemjs-babel-build').pluginsStage2;
var stage1 = require('systemjs-babel-build').pluginsStage1;
var react = require('systemjs-babel-build').pluginsReact;

var externalHelpers = require('systemjs-babel-build').externalHelpers;
var runtimeTransform = require('systemjs-babel-build').runtimeTransform;

require("./lodash.fp.js");
require("./matches.js");

var babelRuntimePath;
var modularHelpersPath = System.decanonicalize('./babel-helpers/', module.id);
var externalHelpersPath = System.decanonicalize('./babel-helpers.js', module.id);
var regeneratorRuntimePath = System.decanonicalize('./regenerator-runtime.js', module.id);

if (modularHelpersPath.substr(modularHelpersPath.length - 3, 3) == '.js')
	modularHelpersPath = modularHelpersPath.substr(0, modularHelpersPath.length - 3);

// in builds we want to embed canonical names to helpers
if (System.getCanonicalName) {
	modularHelpersPath = System.getCanonicalName(modularHelpersPath);
	externalHelpersPath = System.getCanonicalName(externalHelpersPath);
	regeneratorRuntimePath = System.getCanonicalName(regeneratorRuntimePath);
}

// disable SystemJS runtime detection
SystemJS._loader.loadedTranspilerRuntime = true;

function prepend(a, b) {
	for (var p in b)
		if (!(p in a))
			a[p] = b[p];
	return a;
}

/*
 * babelOptions:
 *   modularRuntime: true / false (whether to use babel-runtime or babel/external-helpers respectively)
 *   sourceMaps: true / false (defaults to true)
 *   es2015: true / false (defaults to true)
 *   stage3: true / false (defaults to true)
 *   stage2: true / false (defaults to true)
 *   stage1: true / false (defaults to false)
 *   react: true / false (defaults to false)
 *   plugins: array of custom plugins (objects or module name strings)
 *   presets: array of custom presets (objects or module name strings)
 *   compact: as in Babel
 *   comments: as in Babel
 *
 * babelOptions can be set at SystemJS.babelOptions OR on the metadata object for a given module
 */
var defaultBabelOptions = {
	modularRuntime: true,
	sourceMaps: true,
	es2015: true,
	stage3: true,
	stage2: true,
	stage1: false,
	react: false,
	compact: false,
	comments: true
};

var script2lines = script => script.split("\n");
var stripComments = line => {
	var commentIndex = line.indexOf("//");

	return (commentIndex === -1) ? line : line.slice(0, commentIndex);
};
var trim = line => line.trim();
var expandSet = line => (line && (line[0] !== "(")) ? "(set " + line + ")" : line;
var expandArrays = line => line.replace(/\[/g, "(Array ").replace(/]/g, ")");
var spaceBrackets = line => line.replace(/\(/g, " ( ").replace(/\)/g, " ) ");
var tokenize = line => {
	var quotationSplit = line.split(/([^"]*)/);
	var tokens = [];
	
	while (quotationSplit.length) {
		var section = quotationSplit.shift();

		if (section) {
			if (section === "\"") {
				var quotation = quotationSplit.shift();

				if (_.contains(quotation, ["true", "false"]) || !isNaN(quotation)) quotation = "\"" + quotation + "\"";

				tokens.push(quotation);
				quotationSplit.shift(); // close quote
			} else {
				tokens.push.apply(tokens, section.trim().split(/\s+/));
			}
		}
	}

	return tokens.slice(1, -1);
}
var evaluateToken = token => {
	if (token === "true") return true;
	else if (token === "false") return false;
	else return isNaN(token) ? token : +token; 
};
var tokens2ast = tokens => {
	var ast = [];

	while (tokens.length) {
		var token = tokens.shift();

		if (token === "(") ast.push(tokens2ast(tokens));
		else if (token === ")") return ast;
		else {
			var a = evaluateToken(token);
			ast.push(evaluateToken(token));
		}
	}

	return ast;
};
var set = function(...args) {
	var name = args[0];
	var operator = _.contains("<=", args) ? "<=" : "=>";
	var operatorIndex = args.indexOf(operator);
	var expression = args[operatorIndex + 1];

	if (operator === "<=") {
		this[name] = evaluate(expression);
	} else if (operator === "=>") {
		var parameters = args.slice(1, operatorIndex);

		defn.call(this, name, parameters, expression);
	}
};

var parameter2pattern = parameter => parameter.toLowerCase();
var parameter2argument = parameter => parameter.toLowerCase();
var fn2es6 = (acc, name, parameters, expression) => {
	var jsonValue = JSON.stringify(expression);
	var environmentRef = "environment['" + name + "']";
		
	if (parameters.length) {
		var processedValue = _.reduce(function(acc, parameter) {
			return acc.replace(new RegExp("\"" + parameter + "\"", "g"), parameter);
		}, jsonValue, parameters);
		return {
			output: acc.output +  environmentRef + " = matches.pattern('" + parameters.map(parameter2pattern).join(", ") + "', function(" +
				parameters.join(", ") + ") {" + acc.newlines + "return patternscript.evaluate(environment, " + processedValue + ");}); " +
				environmentRef + ".arity = " + parameters.length + "; ",
			newlines: "\n"
		};
	} else {
		return {
			output: acc.output + environmentRef + " = " + jsonValue + "; ",
			newlines: "\n"
		};
	}
};
var set2es6 = (acc, ...args) => {
	var name = args[0];
	var operator = _.contains("<-", args) ? "<-" : "=>";
	var operatorIndex = args.indexOf(operator);
	var parameters = args.slice(1, operatorIndex);
	var expression = args[operatorIndex + 1];

	if (operator === "<-") {
		return {
			output: acc.output + acc.newlines + "environment['" + name + "'] = patternscript.evaluate(environment, " + JSON.stringify(expression) + "); ",
			newlines: "\n"
		};
	} else if (operator === "=>") {
		return fn2es6(acc, name, parameters, expression);
	}
};
var ast2es6 = (acc, ast) => {
	if (ast[0] === "set") {
		return set2es6.apply(undefined, [acc].concat(ast.slice(1)));
	} else {
		return {
			output: acc.output + acc.newlines + "patternscript.evaluate(environment, " + JSON.stringify(ast) + "); ",
			newlines: "\n"
		}
	}
};
var ps2es6 = source => {
	var astLines = script2lines(source).map(_.flow(
		trim, 
		stripComments, 
		expandSet, 
		expandArrays,
		spaceBrackets, 
		tokenize, 
		tokens2ast
	));

	var output =  astLines.reduce(function(acc, ast) {
		return ast.length ? ast2es6(acc, ast) : {
			output: acc.output,
			newlines: acc.newlines + "\n"
		};
	}, {
		output: "import patternscript from 'patternscript'; var environment = patternscript.rootEnvironment(); ",
		newlines: ""
	}).output;
	
	return output;
};

var rootEnvironment = () => ({
	console: console,
	Math: Math,
	Array: function() {return Array.prototype.slice.call(arguments);},
	"+": function(a, b) {return a + b;},
	"-": function(a, b) {return a - b;},
	"*": function(a, b) {return a * b;},
	"/": function(a, b) {return a / b;},
	".": function(...args) {return dot.apply(this, args);}
});
exports.rootEnvironment = rootEnvironment;


var dot = function(object, property) {
	var object = this[object];
	var value = object[property];

	return _.isFunction(value) ? value.bind(object) : value;
};
var evaluate = function(environment, ast, details) {
	if (!_.isArray(ast) || !ast.length) return ast;

	if (!details) details = {};
	var fn = _.isArray(ast[0]) ? evaluate(environment, ast[0]) : environment[ast[0]];
	var parameters = ast.slice(1);
	
	if (_.isArray(fn)) {
		return evaluate(environment, fn.concat(parameters), details);
	} else if (_.isFunction(fn)) {
		var arity = fn.arity || fn.length;

		if (parameters.length >= arity) {
			var processedParameters = _.map(function(parameter) {
				return evaluate(environment, parameter);
			}, parameters);

			return fn.apply(environment, processedParameters); 
		} else {
			return ast;
		}
	} else {
		return fn;
	}
};
exports.evaluate = evaluate;

exports.translate = function(load, traceOpts) {
	var isPatternscript = load.name.slice(-3) === ".ps";
	var originalSource = load.source;
	if (isPatternscript) {
		load.source = ps2es6(load.source);
	}

	// we don't transpile anything other than CommonJS or ESM
	if (load.metadata.format == 'global' || load.metadata.format == 'amd' || load.metadata.format == 'json')
		throw new TypeError('plugin-babel cannot transpile ' + load.metadata.format + ' modules. Ensure "' + load.name + '" is configured not to use this loader.');

	var loader = this;
	var pluginLoader = loader.pluginLoader || loader;

	// we only output ES modules when running in the builder
	var outputESM = traceOpts ? traceOpts.outputESM : loader.builder;

	var babelOptions = {};

	if (load.metadata.babelOptions)
		prepend(babelOptions, load.metadata.babelOptions);

	if (loader.babelOptions)
		prepend(babelOptions, loader.babelOptions);

	prepend(babelOptions, defaultBabelOptions);

	// determine any plugins or preset strings which need to be imported as modules
	var pluginAndPresetModuleLoads = [];

	if (babelOptions.presets)
		babelOptions.presets.forEach(function(preset) {
			if (typeof preset == 'string')
				pluginAndPresetModuleLoads.push(pluginLoader['import'](preset, module.id));
		});

	if (babelOptions.plugins)
		babelOptions.plugins.forEach(function(plugin) {
			plugin = typeof plugin == 'string' ? plugin : Array.isArray(plugin) && typeof plugin[0] == 'string' && plugin[0];
			if (!plugin)
				return;
			pluginAndPresetModuleLoads.push(pluginLoader.import(plugin, module.id).then(function (m) {
				return m.default || m;
			}));
		});

	return Promise.all(pluginAndPresetModuleLoads)
	.then(function(pluginAndPresetModules) {
		var curPluginOrPresetModule = 0;

		var presets = [];
		var plugins = [];

		if (babelOptions.modularRuntime) {
			if (load.metadata.format == 'cjs')
				throw new TypeError('plugin-babel does not support modular runtime for CJS module transpilations. Set babelOptions.modularRuntime: false if needed.');
			presets.push(runtimeTransform);
		}
		else {
			if (load.metadata.format == 'cjs')
				load.source = 'var babelHelpers = require("' + externalHelpersPath + '");' + load.source;
			else
				load.source = 'import babelHelpers from "' + externalHelpersPath + '";' + load.source;
			presets.push(externalHelpers);
		}

		if (babelOptions.es2015)
			presets.push((outputESM || load.metadata.format == 'cjs') ? es2015 : es2015Register);
		else if (!(outputESM || load.metadata.format == 'cjs'))
			presets.push(modulesRegister);

		if (babelOptions.stage3)
			presets.push({
				plugins: stage3
			});

		if (babelOptions.stage2)
			presets.push({
				plugins: stage2
			});

		if (babelOptions.stage1)
			presets.push({
				plugins: stage1
			});

		if (babelOptions.react)
			presets.push({
				plugins: react
			});

		if (babelOptions.presets)
			babelOptions.presets.forEach(function(preset) {
				if (typeof preset == 'string')
					presets.push(pluginAndPresetModules[curPluginOrPresetModule++]);
				else
					presets.push(preset);
			});

		if (babelOptions.plugins)
			babelOptions.plugins.forEach(function(plugin) {
				if (typeof plugin == 'string')
					plugins.push(pluginAndPresetModules[curPluginOrPresetModule++]);
				else if (Array.isArray(plugin) && typeof plugin[0] == 'string')
					plugins.push([pluginAndPresetModules[curPluginOrPresetModule++], plugin[1]]);
				else
					plugins.push(plugin);
			});

		var output = babel.transform(load.source, {
			babelrc: false,
			plugins: plugins,
			presets: presets,
			filename: load.address,
			sourceFileName: load.address,
			moduleIds: false,
			sourceMaps: traceOpts && traceOpts.sourceMaps || babelOptions.sourceMaps,
			inputSourceMap: load.metadata.sourceMap,
			compact: babelOptions.compact,
			comments: babelOptions.comments,
			code: true,
			ast: true,
			resolveModuleSource: function(m) {
				if (m.substr(0, 22) == 'babel-runtime/helpers/') {
					m = modularHelpersPath + m.substr(22) + '.js';
				}
				else if (m == 'babel-runtime/regenerator') {
					m = regeneratorRuntimePath;
				}
				else if (m.substr(0, 14) == 'babel-runtime/') {
					if (!babelRuntimePath) {
						babelRuntimePath = System.decanonicalize('babel-runtime/', module.id);
						if (babelRuntimePath[babelRuntimePath.length - 1] !== '/')
							babelRuntimePath += '/';
						if (babelRuntimePath.substr(babelRuntimePath.length - 3, 3) == '.js')
							babelRuntimePath = babelRuntimePath.substr(0, babelRuntimePath.length - 3);
						if (loader.getCanonicalName)
							babelRuntimePath = loader.getCanonicalName(babelRuntimePath);
						if (babelRuntimePath == 'babel-runtime/')
							throw new Error('The babel-runtime module must be mapped to support modular helpers and builtins. If using jspm run jspm install npm:babel-runtime.');
					}
					m = babelRuntimePath + m.substr(14) + '.js';
				}
				return m;
			}
		});

		// add babelHelpers as a dependency for non-modular runtime
		if (!babelOptions.modularRuntime)
			load.metadata.deps.push(externalHelpersPath);

		// set output module format
		// (in builder we output modules as esm)
		if (!load.metadata.format || load.metadata.format == 'detect' || load.metadata.format == 'esm')
			load.metadata.format = outputESM ? 'esm' : 'register';

		load.metadata.sourceMap = output.map;

		if (isPatternscript) output.map.sourcesContent[0] = originalSource;

		return output.code;
	});
};
