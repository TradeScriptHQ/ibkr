// biome-ignore-all lint/suspicious/noTemplateCurlyInString: NSIS macros are literal installer source text.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const desktop = new URL('../../apps/desktop/src-tauri/', import.meta.url)
const config = JSON.parse(await readFile(new URL('tauri.conf.json', desktop), 'utf8'))
const template = await readFile(new URL('windows/installer.nsi', desktop), 'utf8')
const body = template.split('; BEGIN PINNED TAURI TEMPLATE\n')[1]
const upstreamSha256 = '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079'
const stableIdentity = 'TradeScript Terminal'
const ownedDeviations = {
  'SHORTCUT POLICY': '227aa51d1639f98a0b778e29dcfc09d67402695f6e05bc36bf0fe52371566464',
  'SHORTCUT MIGRATION': '1064f53b6fa9f1f1e2ed3fbf4aa284c372693248c79ec02b0322e5515eb5b44e',
  'PUBLISHED SHORTCUT CLEANUP': 'eb1a5ff330e921ac3636e20f815d2735b147a4645c259add4c8c4dc376efb9a7',
  'GROUPED SHORTCUT COLLISION GUARD':
    'cdb8e40959cc688f1a81dbe3c1cba23e105f2f0297962b15778e731b20b7c299',
  'START MENU SHORTCUT COLLISION GUARD':
    '12d6e7060ac6eae0638b6e8a3a7a59ef5f15f961f7ab3998b0e637429716ebf9',
  'DESKTOP SHORTCUT COLLISION GUARD':
    '721fdb9451ae3041655a69f010af8b6327125ad3b3a9116a24e134b8ec303192',
}

function deviation(name) {
  const starts = [...body.matchAll(new RegExp(`^([ ]*); BEGIN OWNED ${name}\\n`, 'gm'))]
  assert.equal(starts.length, 1, `${name} is one explicit customization`)
  const { index } = starts[0]
  const ending = `${starts[0][1]}; END OWNED ${name}\n${name.includes('COLLISION GUARD') ? '' : '\n'}`
  const end = body.indexOf(ending, index)
  assert.ok(end > index)
  return body.slice(index, end + ending.length)
}

function macro(name) {
  const matches = [
    ...body.matchAll(new RegExp(`^!macro ${name}[^\\n]*\\n([\\s\\S]*?)^!macroend$`, 'gm')),
  ]
  assert.equal(matches.length, 1)
  return matches[0][1]
}

function definition(name) {
  const definitions = [...body.matchAll(/^!define ([A-Z0-9_]+) "(.*)"$/gm)]
  const matches = definitions.filter(([, key]) => key === name)
  assert.equal(matches.length, 1, `${name} has exactly one definition`)
  return matches[0][2]
}

test('renamed Windows bundle owns its installer without changing application identity', () => {
  assert.equal(config.productName, 'IBKR Tradescript Terminal')
  assert.equal(config.identifier, 'dev.tradescript.ibkr-terminal')
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser')
  assert.equal(config.bundle.windows.nsis.template, 'windows/installer.nsi')
  assert.equal(definition('PRODUCTNAME'), '{{product_name}}')
  assert.equal(definition('BUNDLEID'), '{{bundle_id}}')
  assert.equal(definition('MAINBINARYNAME'), '{{main_binary_name}}')
})

test('pinned Tauri template has only enumerated identity and shortcut deviations', async () => {
  const cli = JSON.parse(
    await readFile(
      new URL('../../node_modules/@tauri-apps/cli/package.json', import.meta.url),
      'utf8',
    ),
  )
  assert.equal(cli.version, '2.11.4', 'review the owned template when the bundler is upgraded')
  assert.ok(template.includes(`; Upstream SHA-256: ${upstreamSha256}`))
  assert.ok(template.includes('; SPDX-License-Identifier: MIT. See TAURI-LICENSE-MIT.txt.'))
  const licence = await readFile(new URL('windows/TAURI-LICENSE-MIT.txt', desktop), 'utf8')
  assert.ok(licence.includes('Copyright (c) 2017 - Present Tauri Apps Contributors'))
  assert.equal((body.match(/^\s*; BEGIN OWNED /gm) ?? []).length, 6)
  let original = body
  for (const [name, sha256] of Object.entries(ownedDeviations)) {
    const block = deviation(name)
    assert.equal(createHash('sha256').update(block).digest('hex'), sha256, name)
    original = original.replace(block, '')
  }
  original = original.replace(`!define INSTALLIDENTITY "${stableIdentity}"\n`, '')
  const identityEdits = [
    ['!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\', 1],
    ['!define MANUPRODUCTKEY "${MANUKEY}\\', 1],
    ['!define PLACEHOLDER_INSTALL_DIR "placeholder\\', 1],
    ['!define MULTIUSER_INSTALLMODE_INSTDIR "', 1],
    ['StrCpy $INSTDIR "$PROGRAMFILES64\\', 2],
    ['StrCpy $INSTDIR "$PROGRAMFILES\\', 2],
    ['StrCpy $INSTDIR "$LOCALAPPDATA\\', 1],
  ]
  for (const [prefix, count] of identityEdits) {
    const replacement = `${prefix}\${INSTALLIDENTITY}"`
    assert.equal(original.split(replacement).length - 1, count, prefix)
    original = original.replaceAll(replacement, `${prefix}\${PRODUCTNAME}"`)
  }
  assert.ok(!original.includes('${INSTALLIDENTITY}'))
  assert.equal(createHash('sha256').update(original).digest('hex'), upstreamSha256)
})

test('published shortcut migration keeps properties and refuses occupied destinations', () => {
  const migration = macro('MigratePublishedShortcut')
  assert.ok(migration.startsWith('  Push $0\n  Push $1\n  Push $2\n  Push $3\n'))
  assert.ok(migration.endsWith('  Pop $3\n  Pop $2\n  Pop $1\n  Pop $0\n'))
  assert.ok(
    migration.includes(
      '!insertmacro IsShortcutTarget "${OLDLINK}" "$INSTDIR\\${MAINBINARYNAME}.exe"\n  Pop $0\n  ${If} $0 = 1\n    ${IfNot} ${FileExists} "${NEWLINK}"\n      ClearErrors\n      Rename "${OLDLINK}" "${NEWLINK}"',
    ),
  )
  assert.equal((migration.match(/^\s*Rename /gm) ?? []).length, 1)
  assert.doesNotMatch(
    migration,
    /Delete|CreateShortcut|REBOOTOK|SetShortcutTarget|FindFirst|FindNext/,
  )
  const placement = deviation('SHORTCUT MIGRATION')
  assert.doesNotMatch(placement, /\$UpdateMode|\$NoShortcutMode|CreateShortcut|Delete/)
  assert.ok(placement.includes('Push $AppStartMenuFolder'))
  assert.ok(placement.includes('Pop $AppStartMenuFolder'))
  const paths = [...placement.matchAll(/!insertmacro MigratePublishedShortcut "(.*)" "(.*)"/g)].map(
    ([, oldPath, newPath]) => [oldPath, newPath],
  )
  assert.deepEqual(paths, [
    [
      '$SMPROGRAMS\\$AppStartMenuFolder\\${INSTALLIDENTITY}.lnk',
      '$SMPROGRAMS\\$AppStartMenuFolder\\${PRODUCTNAME}.lnk',
    ],
    ['$SMPROGRAMS\\${INSTALLIDENTITY}.lnk', '$SMPROGRAMS\\${PRODUCTNAME}.lnk'],
    ['$DESKTOP\\${INSTALLIDENTITY}.lnk', '$DESKTOP\\${PRODUCTNAME}.lnk'],
  ])
  assert.ok(body.indexOf(placement) > body.indexOf('File "${MAINBINARYSRCPATH}"'))
  assert.ok(body.indexOf(placement) < body.indexOf('Call CreateOrUpdateStartMenuShortcut'))
})

test('ordinary uninstall cleans only exact published links targeting this executable', () => {
  const removal = macro('RemovePublishedShortcut')
  assert.ok(removal.startsWith('  Push $0\n  Push $1\n  Push $2\n  Push $3\n'))
  assert.ok(removal.endsWith('  Pop $3\n  Pop $2\n  Pop $1\n  Pop $0\n'))
  assert.ok(
    removal.includes(
      '!insertmacro IsShortcutTarget "${LINK}" "$INSTDIR\\${MAINBINARYNAME}.exe"\n  Pop $0\n  ${If} $0 = 1\n    !insertmacro UnpinShortcut "${LINK}"\n    Delete "${LINK}"',
    ),
  )
  assert.doesNotMatch(removal, /FindFirst|FindNext|RMDir|CreateShortcut|Rename/)
  const uninstall = body
    .split('; Remove shortcuts if not updating\n')[1]
    .split('; Remove registry information for add/remove programs')[0]
  assert.ok(uninstall.trimStart().startsWith('${If} $UpdateMode <> 1'))
  assert.ok(uninstall.trimEnd().endsWith('${EndIf}'))
  assert.ok(uninstall.includes(deviation('PUBLISHED SHORTCUT CLEANUP')))
  assert.equal((uninstall.match(/!insertmacro RemovePublishedShortcut /g) ?? []).length, 3)
  for (const root of ['$SMPROGRAMS\\$AppStartMenuFolder', '$SMPROGRAMS', '$DESKTOP']) {
    assert.ok(
      uninstall.includes(`!insertmacro RemovePublishedShortcut "${root}\\\${INSTALLIDENTITY}.lnk"`),
    )
    assert.ok(
      uninstall.includes(
        `!insertmacro IsShortcutTarget "${root}\\\${PRODUCTNAME}.lnk" "$INSTDIR\\\${MAINBINARYNAME}.exe"`,
      ),
    )
  }
})

test('normal shortcut creation also preserves occupied current-name paths', () => {
  for (const [name, destination] of [
    ['GROUPED SHORTCUT COLLISION GUARD', '$SMPROGRAMS\\$AppStartMenuFolder\\${PRODUCTNAME}.lnk'],
    ['START MENU SHORTCUT COLLISION GUARD', '$SMPROGRAMS\\${PRODUCTNAME}.lnk'],
    ['DESKTOP SHORTCUT COLLISION GUARD', '$DESKTOP\\${PRODUCTNAME}.lnk'],
  ]) {
    const guard = deviation(name)
    assert.ok(
      guard.includes(`\${If} \${FileExists} "${destination}"\n      Return\n    \${EndIf}`) ||
        guard.includes(`\${If} \${FileExists} "${destination}"\n    Return\n  \${EndIf}`),
    )
    assert.doesNotMatch(guard, /Delete|Rename|UnpinShortcut/)
    assert.ok(
      body.includes(
        `${guard}${destination.startsWith('$SMPROGRAMS\\$AppStartMenuFolder') ? '    CreateDirectory "$SMPROGRAMS\\$AppStartMenuFolder"\n' : ''}${destination.startsWith('$DESKTOP') ? '  ' : '    '}CreateShortcut "${destination}"`,
      ),
    )
  }
})

test('previous-install lookup, saved path and updater uninstall retain the published keys', () => {
  assert.equal(definition('INSTALLIDENTITY'), stableIdentity)
  assert.equal(
    definition('UNINSTKEY').replace('${INSTALLIDENTITY}', stableIdentity),
    'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TradeScript Terminal',
  )
  assert.equal(definition('MANUKEY'), 'Software\\${MANUFACTURER}')
  assert.equal(
    definition('MANUPRODUCTKEY').replace('${INSTALLIDENTITY}', stableIdentity),
    '${MANUKEY}\\TradeScript Terminal',
  )
  assert.ok(body.includes('ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""'))
  assert.ok(body.includes('ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"'))
  assert.ok(body.includes('WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR'))
  assert.ok(
    body.includes(
      'Function RestorePreviousInstallLocation\n  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""\n  StrCmp $4 "" +2 0\n    StrCpy $INSTDIR $4\nFunctionEnd',
    ),
  )
  assert.ok(body.includes('StrCpy $R1 "$R1 /UPDATE"'))
  assert.ok(body.includes('${If} $DeleteAppDataCheckboxState = 1\n  ${AndIf} $UpdateMode <> 1'))
  assert.ok(body.includes('RmDir /r "$APPDATA\\${BUNDLEID}"'))
  assert.ok(body.includes('RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"'))
})

test('installation folders stay stable while installer and program labels use the new name', () => {
  assert.equal(definition('PLACEHOLDER_INSTALL_DIR'), 'placeholder\\${INSTALLIDENTITY}')
  assert.ok(body.includes('!define MULTIUSER_INSTALLMODE_INSTDIR "${INSTALLIDENTITY}"'))
  assert.equal(
    (
      body.match(
        /StrCpy \$INSTDIR "\$(?:PROGRAMFILES64|PROGRAMFILES|LOCALAPPDATA)\\\$\{INSTALLIDENTITY\}"/g,
      ) ?? []
    ).length,
    5,
  )
  for (const label of [
    'Name "${PRODUCTNAME}"',
    'VIAddVersionKey "ProductName" "${PRODUCTNAME}"',
    'VIAddVersionKey "FileDescription" "${PRODUCTNAME}"',
    'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"',
  ]) {
    assert.ok(body.includes(label))
  }
})
