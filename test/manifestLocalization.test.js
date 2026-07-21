const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
);
const defaultNls = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.nls.json'), 'utf8')
);
const chineseNls = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.nls.zh-cn.json'), 'utf8')
);
const defaultBundle = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'l10n', 'bundle.l10n.json'), 'utf8')
);
const chineseBundle = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'l10n', 'bundle.l10n.zh-cn.json'), 'utf8')
);

function getLocalizationKey(value) {
    const match = /^%(.+)%$/.exec(value);
    return match ? match[1] : undefined;
}

test('puts all editor context commands inside one Swimming submenu', () => {
    assert.deepEqual(packageJson.contributes.menus['editor/context'], [{
        submenu: 'swimming.menu',
        group: 'navigation',
    }]);
    assert.equal(packageJson.contributes.submenus.length, 1);
    assert.equal(packageJson.contributes.submenus[0].id, 'swimming.menu');
    assert.ok(packageJson.contributes.menus['swimming.menu'].length > 0);
});

test('localizes every manifest label in English and Simplified Chinese', () => {
    const labels = [
        packageJson.displayName,
        packageJson.description,
        packageJson.contributes.submenus[0].label,
        ...packageJson.contributes.commands.map((command) => command.title),
        packageJson.contributes.configuration.title,
        ...Object.values(packageJson.contributes.configuration.properties)
            .map((setting) => setting.description),
    ];

    for (const label of labels) {
        const key = getLocalizationKey(label);
        assert.ok(key, `manifest label is not localized: ${label}`);
        assert.equal(typeof defaultNls[key], 'string', `missing English label: ${key}`);
        assert.equal(typeof chineseNls[key], 'string', `missing Chinese label: ${key}`);
    }
});

test('provides matching runtime translations for English and Simplified Chinese', () => {
    const extensionSource = fs.readFileSync(
        path.join(projectRoot, 'src', 'extension.ts'),
        'utf8'
    );

    assert.equal(packageJson.l10n, './l10n');
    assert.match(extensionSource, /l10n\.t\(/);
    for (const key of Object.keys(defaultBundle)) {
        assert.equal(typeof chineseBundle[key], 'string', `missing Chinese message: ${key}`);
    }
});
