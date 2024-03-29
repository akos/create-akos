'use strict';

const os = require('os');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const urllib = require('urllib');
const mkdirp = require('mkdirp');
const inquirer = require('inquirer');
const yargs = require('yargs');
const glob = require('globby');
const is = require('is-type-of');
const homedir = require('node-homedir');
const compressing = require('compressing');
const rimraf = require('mz-modules/rimraf');
const isTextOrBinary = require('istextorbinary');

require('colors');

module.exports = class Command {
  constructor() {
    this.name = 'create-akos';
    this.configName = 'akos-boilerplate-init-config';
    this.pkgInfo = require('../package.json');
    this.needUpdate = true;
    this.httpClient = urllib.create();

    this.inquirer = inquirer;
    this.fileMapping = {
      gitignore: '.gitignore',
      _gitignore: '.gitignore',
      '_.gitignore': '.gitignore',
      '_package.json': 'package.json',
      '_.eslintignore': '.eslintignore',
      '_.npmignore': '.npmignore',
    };
  }

  /**
   *
   * @param {object} obj origin Object
   * @param {string} key group by key
   * @param {string} otherKey  group by other key
   * @return {object} result grouped object
   */
  groupBy(obj, key, otherKey) {
    const result = {};
    for (const i in obj) {
      let isMatch = false;
      for (const j in obj[i]) {
        // check if obj[i]'s property is 'key'
        if (j === key) {
          const mappingItem = obj[i][j];
          if (typeof result[mappingItem] === 'undefined') {
            result[mappingItem] = {};
          }
          result[mappingItem][i] = obj[i];
          isMatch = true;
          break;
        }
      }
      if (!isMatch) {
        // obj[i] doesn't have property 'key', then use 'otherKey' to group
        if (typeof result[otherKey] === 'undefined') {
          result[otherKey] = {};
        }
        result[otherKey][i] = obj[i];
      }
    }
    return result;
  }
  /**
   * show boilerplate list and let user choose one
   *
   * @param {Object} mapping - boilerplate config mapping, `{ simple: { "name": "simple", "package": "akos-egg-boilerplate-simple", "description": "Simple akos egg app boilerplate" } }`
   * @param {String} type - use in fullstack boilerplate, `client` or `server`
   * @return {Object} boilerplate config item
   */
  async askForBoilerplateType(mapping, type) {
    // group by category
    // group the mapping object by property 'category' or 'other' if item of mapping doesn't have 'category' property
    const groupMapping = this.groupBy(mapping, 'category', 'other');
    const groupNames = Object.keys(groupMapping);
    type = type ? `${type} ` : '';
    let group;
    if (groupNames.length > 1) {
      const answers = await inquirer.prompt({
        name: 'group',
        type: 'list',
        message: `Please select a ${type}boilerplate category`,
        choices: groupNames,
        pageSize: groupNames.length,
      });
      group = groupMapping[answers.group];
    } else {
      group = groupMapping[groupNames[0]];
    }

    // ask for boilerplate
    const choices = Object.keys(group).map(key => {
      const item = group[key];
      return {
        name: `${key} - ${item.description}`,
        value: item,
      };
    });

    choices.unshift(new inquirer.Separator());
    const { boilerplateInfo } = await inquirer.prompt({
      name: 'boilerplateInfo',
      type: 'list',
      message: `Please select a ${type}boilerplate type`,
      choices,
      pageSize: choices.length,
    });
    if (!boilerplateInfo.deprecate) return boilerplateInfo;

    // ask for deprecate
    const { shouldInstall } = await inquirer.prompt({
      name: 'shouldInstall',
      type: 'list',
      message: 'It\'s deprecated',
      choices: [
        {
          name: `1. ${boilerplateInfo.deprecate}`,
          value: false,
        },
        {
          name: '2. I still want to continue installing',
          value: true,
        },
      ],
    });

    if (shouldInstall) {
      return boilerplateInfo;
    } else {
      console.log(`Exit due to: ${boilerplateInfo.deprecate}`);
      return;
    }
  }

  /**
   * ask user to provide variables which is defined at boilerplate
   * @param {String} targetDir - target dir
   * @param {String} templateDir - template dir
   * @return {Object} variable scope
   */
  async askForVariable(targetDir, templateDir) {
    let questions;
    try {
      questions = require(templateDir);
      // support function
      if (is.function(questions)) {
        questions = questions(this);
      }
      // use target dir name as `name` default
      if (questions.name && !questions.name.default) {
        questions.name.default = path.basename(targetDir).replace(/^egg-/, '');
      }
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') {
        this.log(`load boilerplate config got trouble, skip and use defaults, ${err.message}`.yellow);
      }
      return {};
    }

    this.log('collecting boilerplate config...');
    const keys = Object.keys(questions);
    if (this.argv.silent) {
      const result = keys.reduce((result, key) => {
        const defaultFn = questions[key].default;
        const filterFn = questions[key].filter;
        if (typeof defaultFn === 'function') {
          result[key] = defaultFn(result) || '';
        } else {
          result[key] = questions[key].default || '';
        }
        if (typeof filterFn === 'function') {
          result[key] = filterFn(result[key]) || '';
        }

        return result;
      }, {});
      this.log('use default due to --silent, %j', result);
      return result;
    } else {
      return await inquirer.prompt(keys.map(key => {
        const question = questions[key];
        return {
          type: question.type || 'input',
          name: key,
          message: question.description || question.desc,
          default: question.default,
          filter: question.filter,
          choices: question.choices,
        };
      }));
    }
  }

  /**
   * copy boilerplate to target dir with template scope replace
   * @param {String} targetDir - target dir
   * @param {String} templateDir - template dir, must contain a folder which named `boilerplate`
   * @return {Array} file names
   */
  async processFiles(targetDir, templateDir) {
    const src = path.join(templateDir, 'boilerplate');
    const locals = await this.askForVariable(targetDir, templateDir);
    const files = glob.sync('**/*', { cwd: src, dot: true });
    files.forEach(file => {
      const from = path.join(src, file);
      const to = path.join(targetDir, this.replaceTemplate(this.fileMapping[file] || file, locals));
      const content = fs.readFileSync(from);
      this.log('write to %s', to);

      // check if content is a text file
      const result = isTextOrBinary.isTextSync(from, content)
        ? this.replaceTemplate(content.toString('utf8'), locals)
        : content;

      mkdirp.sync(path.dirname(to));
      fs.writeFileSync(to, result);
    });
    return files;
  }

  /**
   * get argv parser
   * @return {Object} yargs instance
   */
  getParser() {
    return yargs
      .usage('init egg project from boilerplate.\nUsage: $0 [dir] --type=simple')
      .options(this.getParserOptions())
      .alias('h', 'help')
      .version()
      .help();
  }

  /**
   * get yargs options
   * @return {Object} opts
   */
  getParserOptions() {
    return {
      type: {
        type: 'string',
        description: 'boilerplate type',
      },
      dir: {
        type: 'string',
        description: 'target directory',
      },
      force: {
        type: 'boolean',
        description: 'force to override directory',
        alias: 'f',
      },
      template: {
        type: 'string',
        description: 'local path to boilerplate',
      },
      package: {
        type: 'string',
        description: 'boilerplate package name',
      },
      registry: {
        type: 'string',
        description: 'npm registry, support china/npm/custom, default to auto detect',
        alias: 'r',
      },
      silent: {
        type: 'boolean',
        description: 'don\'t ask, just use default value',
      },
    };
  }

  /**
   * get registryUrl by short name
   * @param {String} key - short name, support `china / npm / npmrc`, default to read from .npmrc
   * @return {String} registryUrl
   */
  getRegistryByType(key) {
    switch (key) {
      case 'china':
        return 'https://registry.npm.taobao.org';
      case 'npm':
        return 'https://registry.npmjs.org';
      case 'netease':
        return 'http://rnpm.hz.netease.com';
      default: {
        if (/^https?:/.test(key)) {
          return key.replace(/\/$/, '');
        } else {
          // support .npmrc
          const home = homedir();
          let url = process.env.npm_registry || process.env.npm_config_registry || 'https://registry.npmjs.org';
          if (fs.existsSync(path.join(home, '.cnpmrc')) || fs.existsSync(path.join(home, '.tnpmrc'))) {
            url = 'https://registry.npmjs.org';
          }
          url = url.replace(/\/$/, '');
          return url;
        }
      }
    }
  }

  /**
   * ask for target directory, will check if dir is valid.
   * @return {String} Full path of target directory
   */
  async getTargetDirectory() {
    let dir = this.argv._[0] || this.argv.dir || '';
    dir = String(dir);
    let targetDir = path.resolve(this.cwd, dir);
    const force = this.argv.force;

    const validate = dir => {
      // create dir if not exist
      if (!fs.existsSync(dir)) {
        mkdirp.sync(dir);
        return true;
      }

      // not a directory
      if (!fs.statSync(dir).isDirectory()) {
        return `${dir} already exists as a file`.red;
      }

      // check if directory empty
      const files = fs.readdirSync(dir).filter(name => name[0] !== '.');
      if (files.length > 0) {
        if (force) {
          this.log(`${dir} already exists and will be override due to --force`.red);
          return true;
        }
        return `${dir} already exists and not empty: ${JSON.stringify(files)}`.red;
      }
      return true;
    };

    // if argv dir is invalid, then ask user
    const isValid = validate(targetDir);
    if (isValid !== true) {
      this.log(isValid);
      const answer = await this.inquirer.prompt({
        name: 'dir',
        message: 'Please enter target dir: ',
        default: dir || '.',
        filter: dir => path.resolve(this.cwd, dir),
        validate,
      });
      targetDir = answer.dir;
    }
    this.log(`target dir is ${targetDir}`);
    return targetDir;
  }

  /**
   * find template dir from support `--template=`
   * @return {String} template files dir
   */
  async getTemplateDir() {
    let templateDir;
    // when use `egg-init --template=PATH`
    if (this.argv.template) {
      templateDir = path.resolve(this.cwd, this.argv.template);
      if (!fs.existsSync(templateDir)) {
        this.log(`${templateDir} is not exists`.red);
      } else if (!fs.existsSync(path.join(templateDir, 'boilerplate'))) {
        this.log(`${templateDir} should contain boilerplate folder`.red);
      } else {
        this.log(`local template dir is ${templateDir.green}`);
        return templateDir;
      }
    }
  }

  /**
   * fetch boilerplate mapping from `akos-boilerplate-init-config`
   * @param {String} [pkgName] - config package name, default to `this.configName`
   * @param {String} type - use in fullstack boilerplate, `client` or `server`
   * @return {Object} boilerplate config mapping, `{ simple: { "name": "simple", "package": "egg-boilerplate-simple", "description": "Simple egg app boilerplate" } }`
   */
  async fetchBoilerplateMapping(pkgName, type) {
    const pkgInfo = await this.getPackageInfo(pkgName || this.configName, true);
    let mapping = pkgInfo.config.boilerplate;
    if (type === 'client' || type === 'server') {
      mapping = pkgInfo.config[type];
    }
    Object.keys(mapping).forEach(key => {
      const item = mapping[key];
      item.name = item.name || key;
      item.from = pkgInfo;
    });
    return mapping;
  }

  /**
   * print usage guide
   */
  printUsage() {
    this.log(`usage:
      - cd ${this.targetDir}
      - npm install
      - npm start / npm run dev / npm test
    `);
  }

  /**
   * print fullstack usage guide
   */
  fullstackPrintUsage() {
    this.log(`usage:
      - cd ${this.targetDir}
      - npm run init:server
      - npm run init:client
      - npm run build:client
      - npm start / npm run dev && npm run dev:client
    `);
  }

  /**
   * replace content with template scope,
   * - `{{ test }}` will replace
   * - `\{{ test }}` will skip
   *
   * @param {String} content - template content
   * @param {Object} scope - variable scope
   * @return {String} new content
   */
  replaceTemplate(content, scope) {
    return content.toString().replace(/(\\)?{{ *(\w+) *}}/g, (block, skip, key) => {
      if (skip) {
        return block.substring(skip.length);
      }
      return scope.hasOwnProperty(key) ? scope[key] : block;
    });
  }

  /**
   * download boilerplate by pkgName then extract it
   * @param {String} pkgName - boilerplate package name
   * @return {String} extract directory
   */
  async downloadBoilerplate(pkgName) {
    const result = await this.getPackageInfo(pkgName, false);
    const tgzUrl = result.dist.tarball;

    this.log(`downloading ${tgzUrl}`);

    const saveDir = path.join(os.tmpdir(), `akos-boilerplate-init-config/${pkgName}`);
    // rm -rf {saveDir}
    await rimraf(saveDir);
    // download tgz
    const response = await this.curl(tgzUrl, { streaming: true, followRedirect: true });
    // compress tgz
    await compressing.tgz.uncompress(response.res, saveDir);

    this.log(`extract to ${saveDir}`);
    return path.join(saveDir, '/package');
  }

  /**
   * send curl to remote server
   * @param {String} url - target url
   * @param {Object} [options] - request options
   * @return {Object} response data
   */
  async curl(url, options) {
    return await this.httpClient.request(url, options);
  }

  /**
   * get package info from registry
   *
   * @param {String} pkgName - package name
   * @param {Boolean} [withFallback] - when http request fail, whethe to require local
   * @return {Object} pkgInfo
   */
  async getPackageInfo(pkgName, withFallback) {
    this.log(`fetching npm info of ${pkgName}`);
    try {
      const result = await this.curl(`${this.registryUrl}/${pkgName}/latest`, {
        dataType: 'json',
        followRedirect: true,
        maxRedirects: 5,
        timeout: 5000,
      });
      assert(result.status === 200, `npm info ${pkgName} got error: ${result.status}, ${result.data.reason}`);
      return result.data;
    } catch (err) {
      if (withFallback) {
        this.log(`use fallback from ${pkgName}`);
        return require(`${pkgName}/package.json`);
      } else {
        throw err;
      }
    }
  }

  /*
   * log with prefix
   */
  log() {
    const args = Array.prototype.slice.call(arguments);
    args[0] = `[${this.name}] `.blue + args[0];
    console.log.apply(console, args);
  }
};
