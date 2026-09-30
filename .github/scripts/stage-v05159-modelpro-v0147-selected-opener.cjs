const fs = require('node:fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Missing patch anchor: ${label}`);
  return source.replace(oldValue, newValue);
}

const contentPath = 'extension/content.js';
let content = read(contentPath);
const oldOpener = `  function redesignedModelViewOpener(picker) {
    if (!picker || !visible(picker)) return null;
    const candidates = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => interactionVisible(element))
      .filter((element) => !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'))
      .filter((element) => {
        const descriptor = rowModelDescriptor(element);
        if (descriptor.model || descriptor.rawId) return false;
        if (element.matches?.('[role="slider"],input[type="range"]')) return false;
        if (element.querySelector?.('[role="slider"],input[type="range"]')) return false;
        const label = normalizedPickerLabel(element).replace(/[›»>]+\\s*$/, '').trim();
        return Boolean(normalizeDisplayedReasoning(label));
      });
    return candidates.length === 1 ? candidates[0] : null;
  }
`;
const newOpener = `  function redesignedModelViewOpener(picker) {
    if (!picker || !visible(picker)) return null;
    const exactModelViewName = /^(?:select model|choose model|选择模型|選擇模型|모델 선택)$/i;
    const candidates = [...picker.querySelectorAll('[role="menuitem"],button,[role="button"]')]
      .filter((element) => interactionVisible(element))
      .filter((element) => !element.closest?.('#gptlock-indicator-host,#gptlock-verification-progress-host'))
      .filter((element) => {
        if (element.matches?.('[role="slider"],input[type="range"]')) return false;
        if (element.querySelector?.('[role="slider"],input[type="range"]')) return false;
        // Current ChatGPT keeps this ViewTrack toggle's accessible name stable as
        // "选择模型 / Select model" after selection, while visible text becomes
        // a model+effort summary such as "5.5 高". Accessible identity must win
        // before that text can be parsed as a concrete model row.
        const accessibleName = String(
          element.getAttribute?.('aria-label') || element.getAttribute?.('title') || ''
        ).trim();
        if (exactModelViewName.test(accessibleName)) return true;
        const descriptor = rowModelDescriptor(element);
        if (descriptor.model || descriptor.rawId) return false;
        const label = normalizedPickerLabel(element).replace(/[›»>]+\\s*$/, '').trim();
        return Boolean(normalizeDisplayedReasoning(label));
      });
    return candidates.length === 1 ? candidates[0] : null;
  }
`;
content = replaceOnce(content, oldOpener, newOpener, 'redesigned model-view opener');

const oldNavigationTail = `        if (redesignedDirectRows.length === 2) {
          pickerTopologyProbe('picker-mode-a-redesigned-model-view', {
            pageContext,
            pickerMode: 'A',
            ownedPicker: compactElementProbe(picker),
            modelRows: redesignedDirectRows.map((row) => ({
              element: compactElementProbe(row),
              descriptor: rowModelDescriptor(row),
            })),
          });
          return { trigger, picker, opener: null, submenu: picker, rows: redesignedDirectRows, pageContext, pickerMode: 'A' };
        }
      }
    }

    const initialOpener = modelSubmenuOpener(picker);`;
const newNavigationTail = `        if (redesignedDirectRows.length === 2) {
          pickerTopologyProbe('picker-mode-a-redesigned-model-view', {
            pageContext,
            pickerMode: 'A',
            ownedPicker: compactElementProbe(picker),
            modelRows: redesignedDirectRows.map((row) => ({
              element: compactElementProbe(row),
              descriptor: rowModelDescriptor(row),
            })),
          });
          return { trigger, picker, opener: null, submenu: picker, rows: redesignedDirectRows, pageContext, pickerMode: 'A' };
        }
        // A dispatched ViewTrack navigation owns this attempt. Never fall through
        // to modelSubmenuOpener and click the same Select-model toggle a second time.
        pickerTopologyProbe('picker-redesign-model-view-unresolved', {
          pageContext,
          pickerMode: 'A',
          opener: compactElementProbe(modelViewOpener),
          ownedPicker: compactElementProbe(picker),
        });
        return { trigger, picker, opener: modelViewOpener, submenu: null, rows: [], pageContext, pickerMode: 'A' };
      }
    }

    const initialOpener = modelSubmenuOpener(picker);`;
content = replaceOnce(content, oldNavigationTail, newNavigationTail, 'ViewTrack single navigation authority');
write(contentPath, content);

const versionFiles = [
  ['extension/manifest.json', '"version": "0.5.158"', '"version": "0.5.159"'],
  ['extension/package.json', '"version": "0.5.158"', '"version": "0.5.159"'],
  ['extension/background.js', "const RUNTIME_CODE_VERSION = '0.5.158';", "const RUNTIME_CODE_VERSION = '0.5.159';"],
  ['native-core/Cargo.toml', 'version = "0.5.158"', 'version = "0.5.159"'],
  ['native-core/Cargo.lock', 'name = "gptwork-core"\nversion = "0.5.158"', 'name = "gptwork-core"\nversion = "0.5.159"'],
  ['packaging/windows/GPTWork.iss', '#define MyAppVersion "0.5.158"', '#define MyAppVersion "0.5.159"'],
];
for (const [path, oldValue, newValue] of versionFiles) {
  write(path, replaceOnce(read(path), oldValue, newValue, `${path} version`));
}

const sourcePath = 'extension/vendor/modelpro/MODELPRO_SOURCE.json';
let source = read(sourcePath);
source = replaceOnce(source, '"version": "0.1.46"', '"version": "0.1.47"', 'ModelPro source version');
source = replaceOnce(
  source,
  '"commit": "f674411521d54f03682b7c60102a9c21d449f53d"',
  '"commit": "8a6d468b52ccba7395b56ac3c243773e3a420c8b"',
  'ModelPro source commit',
);
write(sourcePath, source);
