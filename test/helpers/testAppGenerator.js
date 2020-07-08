const path = require('path');
const rimraf = require('rimraf');
const execa = require('execa');
const fs = require('fs-extra');
const { promisify } = require('util');

const rm = promisify(rimraf);

/**
 * Delete the testApp folder
 * @param {string} appName - name of the app / folder where the app is located
 */
const cleanTestApp = async appName => {
  await Promise.all([
    rm(path.resolve(appName, '.cache')),
    rm(path.resolve(appName, '.temp')),
    rm(path.resolve(appName, 'public')),
    rm(path.resolve(appName, 'build')),
    rm(path.resolve(appName, 'api')),
    rm(path.resolve(appName, 'extensions')),
    rm(path.resolve(appName, 'components')),
  ]);

  await fs.mkdir('api');
  await fs.mkdir('extensions');
};

/**
 * Starts the test App in the appName folder
 * @param {Object} options - Options
 * @param {string} options.appName - Name of the app / folder in which run the start script
 */
const startTestApp = ({ appName }) => {
  return execa('BROWSER=none node_modules/.bin/strapi develop --no-build', {
    stdio: 'inherit',
    cwd: path.resolve(appName),
    shell: true,
  });
};

const copyTests = async appName => {
  const strapiDir = path.dirname(require.resolve('strapi/package.json'));
  const rootDir = path.resolve(appName);
  const testsDir = '__tests__';
  const dest = path.join(rootDir, testsDir);

  await fs.emptyDir(dest);
  await fs.copy(path.join(strapiDir, testsDir), dest);
};

module.exports = {
  cleanTestApp,
  startTestApp,
  copyTests
};