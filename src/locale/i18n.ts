/**
 * 国际化 (i18n) 模块
 *
 * 提供中英文切换能力，所有面向用户的 UI 文本通过此模块获取。
 * 修改显示文本不会影响任何代码变量名、属性名或业务逻辑。
 */

export type Locale = 'en' | 'zh-cn';

// ─── 当前语言状态 ────────────────────────────────────────────────
let currentLocale: Locale = 'en';

export function setLocale(loc: Locale) {
  currentLocale = loc;
}

export function getLocale(): Locale {
  return currentLocale;
}

// ─── 字符串映射表 ─────────────────────────────────────────────────
type StringMap = Record<string, string>;

const en: StringMap = {
  // ── 设置 - 通用 ──
  'settings.general': 'General Settings',
  'settings.database': 'Database',
  'settings.database.desc':
    'Supports Zotero and Juris-M. Alternatively a custom port number can be specified.',
  'settings.port': 'Port number',
  'settings.port.desc':
    'If a custom port number has been set in Zotero, enter it here.',
  'settings.port.placeholder': 'Example: 23119',
  'settings.noteImportFolder': 'Note Import Location',
  'settings.noteImportFolder.desc':
    'Notes imported from Zotero will be added to this folder in your vault',
  'settings.noteImportFolder.placeholder': 'Example: folder 1/folder 2',
  'settings.storage.heading': 'Storage & Attachments',
  'settings.baseStorageFolder': 'Base Storage Folder (Smart Routing)',
  'settings.baseStorageFolder.desc':
    'v3.0: Root folder for smart multi-level directory routing. Zotero collections will be auto-created as subdirectories under this base folder.',
  'settings.baseStorageFolder.placeholder': 'Example: ZoteroLibrary',
  'settings.openAfterImport': 'Open the created or updated note(s) after import',
  'settings.openAfterImport.desc':
    'The created or updated markdown files resulting from the import will be automatically opened.',
  'settings.whichNotesToOpen': 'Which notes to open after import',
  'settings.whichNotesToOpen.desc':
    'Open either the first note imported, the last note imported, or all notes in new tabs.',
  'settings.whichNotes.first': 'First imported note',
  'settings.whichNotes.last': 'Last imported note',
  'settings.whichNotes.all': 'All imported notes',
  'settings.concat': 'Enable Annotation Concatenation',
  'settings.concat.desc':
    "Annotations extracted from PDFs that begin with '+' will be appended to the previous annotation. Note: Annotation ordering is not always consistent and you may not always achieve the desired concatenation result.",
  'settings.locale': 'Language / 语言',
  'settings.locale.desc': 'Change the display language of the plugin settings.',

  // ── 设置 - 引用格式 ──
  'settings.citeFormats': 'Citation Formats',
  'settings.addCiteFormat': 'Add Citation Format',

  // ── 设置 - 导入格式 ──
  'settings.importFormats': 'Import Formats',
  'settings.addImportFormat': 'Add Import Format',

  // ── 设置 - 图片 ──
  'settings.imageSettings': 'Import Image Settings',
  'settings.imageSettings.desc':
    'Rectangle annotations will be extracted from PDFs as images.',
  'settings.imageFormat': 'Image Format',
  'settings.imageQuality': 'Image Quality (jpg only)',
  'settings.imageDPI': 'Image DPI',
  'settings.imageOCR': 'Image OCR',
  'settings.imageOCR.tesseractPath': 'Tesseract path',
  'settings.imageOCR.tesseractPath.desc1':
    'Required: An absolute path to the tesseract executable. This can be found on mac and linux with the terminal command',
  'settings.imageOCR.lang': 'Image OCR Language',
  'settings.imageOCR.lang.desc1':
    'Optional: defaults to english. Multiple languages can be specified like so:',
  'settings.imageOCR.lang.desc2': 'Each language must be installed on your system.',
  'settings.imageOCR.lang.desc3': 'Languages can be downloaded here',
  'settings.imageOCR.lang.desc4':
    'here for a description of the language codes',
  'settings.imageOCR.tessDataDir': 'Tesseract data directory',
  'settings.imageOCR.tessDataDir.desc':
    "Optional: supply an absolute path to the directory where tesseract's language files reside. This folder should include *.traineddata files for your selected languages.",

  // Image OCR - long description (as JSX fragments, keyed separately)
  'settings.imageOCR.desc.line1':
    'Attempt to extract text from images created by rectangle annotations. This requires that',
  'settings.imageOCR.desc.line2': 'be installed on your system. Tesseract can be installed from',
  'settings.imageOCR.desc.line3': 'homebrew on mac',
  'settings.imageOCR.desc.line4': ', various linux package managers, and from',
  'settings.imageOCR.desc.line5': 'here on windows',

  // ── 设置 - PDF Utility ──
  'settings.pdfUtility': 'PDF Utility',
  'settings.pdfUtility.desc1': 'Extracting data from PDFs requires an external tool.',
  'settings.pdfUtility.desc2':
    'This plugin will still work without it, but annotations will not be included in exports.',
  'settings.pdfUtility.override': 'PDF Utility Path Override',
  'settings.pdfUtility.override.desc1':
    'Override the path to the PDF utility. Specify an absolute path to the pdfannots2json executable.',
  'settings.pdfUtility.override.desc2': 'Download the executable here.',
  'settings.pdfUtility.override.desc3':
    'You may need to provide Obsidian the appropriate OS permissions to access the executable.',
  'settings.pdfUtility.upToDate': 'PDF utility is up to date.',
  'settings.pdfUtility.needsUpdate':
    'The PDF extraction tool requires updating. Please re-download.',
  'settings.pdfUtility.clickToDownload': 'Click the button to download.',
  'settings.pdfUtility.download': 'Download',
  'settings.pdfUtility.downloading': 'Downloading...',
  'settings.pdfUtility.findTesseract': 'Attempt to find tesseract automatically',
  'settings.pdfUtility.findTesseract.fail':
    'Unable to find tesseract on your system. If it is installed, please manually enter a path.',
  'settings.pdfUtility.selectExe': 'Select the pdfannots2json executable',
  'settings.pdfUtility.selectTessDataDir': 'Select the tesseract data directory',

  // ── 导出格式设置 ──
  'export.name': 'Name',
  'export.outputPath': 'Output Path',
  'export.outputPath.note':
    'The file path of the exported markdown. Supports templating, eg',
  'export.outputPath.note2':
    "Templates have access to data from the Zotero item and its first attachment.",
  'export.imageOutputPath': 'Image Output Path',
  'export.imageOutputPath.note':
    'The folder in which images should be saved. Supports templating, eg',
  'export.imageBaseName': 'Image Base Name',
  'export.imageBaseName.note1':
    'The base file name of exported images. Eg.',
  'export.imageBaseName.note2': 'will result in',
  'export.imageBaseName.note3': 'where',
  'export.imageBaseName.note4': 'is the page number and',
  'export.imageBaseName.note5': 'and',
  'export.imageBaseName.note6':
    'are the x and y coordinates of rectangle annotation on the page. Supports templating. Templates have access to data from the Zotero item and its first attachment.',
  'export.templateFile': 'Template File',
  'export.templateFile.note1':
    'Open the data explorer from the command pallet to see available template data. Templates are written using',
  'export.templateFile.note2': 'See the templating documentation here',
  'export.search': 'Search...',
  'export.style': 'Bibliography Style',
  'export.style.note':
    'Note, the chosen style must be installed in Zotero. See',
  'export.style.note2': 'Zotero: Citation Styles',
  'export.removeTemplate': 'Remove Template',
  'export.deprecated.header': 'Header Template File (deprecated)',
  'export.deprecated.annotation': 'Annotation Template File (deprecated)',
  'export.deprecated.footer': 'Footer Template File (deprecated)',
  'export.deprecated.note':
    'Deprecated: Separate template files are no longer needed.',
  'export.cslSearch': 'Type to search CSL styles',
  'export.fileSearch': 'Type to search',

  // ── 引用格式设置 ──
  'cite.name': 'Name',
  'cite.outputFormat': 'Output Format',
  'cite.template': 'Template',
  'cite.template.note1':
    "Citation templates have access to a subset of the Zotero item's data. The item's first attachment is available under the",
  'cite.template.note2':
    'key. Annotations are not provided. Open the data explorer from the command pallet to see available template data. Templates are written using',
  'cite.style.citation': 'Citation Style',
  'cite.style.bibliography': 'Bibliography Style',
  'cite.style.note':
    'Note, the chosen style must be installed in Zotero. See',
  'cite.style.note2': 'Zotero: Citation Styles',
  'cite.command': 'Citation Command',
  'cite.brackets': 'Include Brackets',

  // ── Data Explorer ──
  'dataExplorer.prompt': 'Prompt For Selection',
  'dataExplorer.preview': 'Preview Import Format',
  'dataExplorer.noData': 'No data retrieved',
  'dataExplorer.title': 'Zotero Data Explorer',
  'dataExplorer.copyPath': 'Copy template path',
  'dataExplorer.copyLoop': 'Copy template for loop',
  'dataExplorer.templateData': 'Template Data',

  // ── 命令名称 ──
  'command.insertNotes': 'Insert notes into current document',
  'command.importNotes': 'Import notes',
  'command.dataExplorer': 'Data explorer',
  'command.quickImport': 'Quick Import (Visual Mappings)',
  'command.updateMetadata': 'Update Metadata (YAML only)',
  'command.syncAnnotations': 'Sync Annotations (Body only)',
  'command.copyCitation': 'Copy Citation to Clipboard',
  'command.insertItemInfo': 'Insert Item Info (YAML)',
  'command.insertAnnotations': 'Insert Notes & Annotations',
  'command.insertBibliography': 'Insert Bibliography',

  // ── 模态框 / 提示 ──
  'modal.fetchingData': 'Fetching data from Zotero...',
  'modal.fetchingNotes': 'Fetching notes from Zotero...',
  'modal.fetchingCollections': 'Fetching collections from Zotero...',
  'modal.awaitingSelection': 'Awaiting item selection from Zotero...',
  'modal.extractingAnnotations': 'Extracting annotations...',
  'modal.updatingPDFUtility': 'Updating Obsidian Zotero Integration PDF Utility...',

  // ── 通知 / 错误 ──
  'notice.zoteroNotRunning':
    'Cannot connect to Zotero. Please ensure it is running and the Better BibTeX plugin is installed',
  'notice.citationError': 'Error processing citation:',
  'notice.citeKeyError': 'Error retrieving cite key:',
  'notice.noNotesFound': 'No notes found for selected items',
  'notice.importFailed':
    'Import failed for %s, check developer console for details',
  'notice.errorCreatingFile': 'Error creating file "%s":',
  'notice.errorRetrievingNotes': 'Error retrieving notes:',
  'notice.errorRetrievingBib': 'Error retrieving formatted bibliography:',
  'notice.errorRetrievingItem': 'Error retrieving item data:',
  'notice.errorRetrievingLibraryId': 'Error retrieving library id:',
  'notice.errorSearching': 'Error searching:',
  'notice.emptyBib':
    "Error: Received empty bibliography from Zotero. Ensure Zotero's quick copy settings are set and the selected citation style is installed.",
  'notice.convertError': 'Error converting formatted bibliography to markdown:',
  'notice.pdfPassword': 'Error opening %s: PDF is password protected',
  'notice.pdfNotExecutable': 'Error: PDF utility is not executable',
  'notice.pdfProcessingError': 'Error processing PDF:',
  'notice.pdfAnnotationError': 'Error processing annotations:',
  'notice.pdfDownloadError':
    'Error downloading PDF utility. Check the console for more details.',
  'notice.pdfVersionError': 'Error checking PDF utility version:',
  'notice.cannotCopyImage':
    'Error: unable to copy annotation image from Zotero into your vault',
  'notice.templateNotFound': 'Error: %s template not found %s',
  'notice.importFormatNotFound': 'Error: Import format "%s" not found',
  'notice.noTemplates':
    'No templates found for export %s',
  'notice.metadataUpdated': 'Metadata YAML updated for %s file(s).',
  'notice.annotationsSynced': 'Annotations synced for %s file(s).',
  'notice.citationCopied': 'Citation "%s" copied to clipboard.',
  'notice.noFilesToUpdate':
    'No existing files found. Run a full import first.',
  'notice.noCitationReturned': 'No citation returned from Zotero.',
  'notice.itemInfoInserted': 'Inserted YAML info for %s item(s).',
  'notice.annotationsInserted': 'Inserted notes for %s item(s).',
  'notice.bibInserted': 'Inserted bibliography for %s item(s).',

  // ── 模板错误 ──
  'error.parsingTemplate': 'Error parsing template "%s":',
  'error.cannotFindFile': 'Cannot find file. Invalid markdown link:',
  'error.fileNotFound': 'Cannot find file. File not found:',

  // ── 影响因子颜色配置 ──
  'settings.ifColorRules': 'Impact Factor Color Configuration',
  'settings.ifColorRules.desc':
    'Dynamically color IF values in the Properties panel based on value ranges.',
  'settings.ifColorRules.add': 'Add Rule',
  'settings.ifColorRules.min': 'Min IF',
  'settings.ifColorRules.max': 'Max IF (empty = ∞)',
  'settings.ifColorRules.bgColor': 'Background',
  'settings.ifColorRules.textColor': 'Text Color',
  'settings.ifColorRules.delete': 'Delete',
  'settings.ifColorRules.preview': 'Preview',

  // ── 标题跑马灯 ──
  'settings.titleMarquee': 'Literature Title Display',
  'settings.titleMarquee.desc':
    'Apply a scrolling marquee animation to long titles in the Properties panel.',
  'settings.titleMarquee.enable': 'Enable Title Marquee',
  'settings.titleMarquee.enable.desc':
    'When enabled, long titles will scroll horizontally to reveal the full text.',
  'settings.titleMarquee.duration': 'Scroll Duration (seconds)',
  'settings.titleMarquee.duration.desc':
    'Time in seconds for one complete scroll cycle. Default: 15s.',

  // ── v4.0 工作流导向 Tab ──
  'settings.tab.metadata': 'Metadata Mapping',
  'settings.tab.notes': 'Notes Template',
  'settings.tab.citation': 'Citation Format',
  'settings.tab.sync': 'Update & Sync',

  // ── System Header ──
  'settings.system': 'System Settings',
  'settings.advanced': 'Advanced (Image & OCR)',

  // ── Metadata Tab ──
  'settings.metadata.propertyMappings': 'Property Mappings',
  'settings.metadata.propertyMappings.desc':
    'Map Zotero fields to Obsidian YAML properties. Drag ⋮⋮ to reorder. These become the frontmatter of each imported note.',
  'settings.metadata.customProperties': 'Custom Properties',
  'settings.metadata.customProperties.desc':
    'Define extra Obsidian-native property presets with default values. Added to new notes but never overwritten during incremental updates.',
  'settings.metadata.propertyItems': 'Property Items',
  'settings.metadata.propertyItems.desc':
    'Unified list of Zotero field mappings and custom properties. Drag ⋮⋮ to reorder. Choose the type for each row.',
  'settings.metadata.propertyItems.empty': 'No properties defined yet',
  'settings.metadata.propertyItems.add': 'Add Property',
  'settings.metadata.propertyItems.addZotero': 'Add Zotero Field',
  'settings.metadata.propertyItems.addCustom': 'Add Custom Property',
  'settings.metadata.propertyItems.kind': 'Type',
  'settings.metadata.propertyItems.kindZotero': 'Zotero Field',
  'settings.metadata.propertyItems.kindCustom': 'Custom',
  'settings.metadata.customProperties.key': 'Name',
  'settings.metadata.customProperties.value': 'Default Value',
  'settings.metadata.triggerFeatureKey': 'Floating Button Trigger Key',
  'settings.metadata.triggerFeatureValue': 'Floating Button Trigger Value',
  'settings.metadata.triggerFeatureKey.desc':
    'The floating sync button only appears when the current note YAML contains this key (default: Title).',
  'settings.metadata.triggerFeatureValue.desc':
    'Optional: If set, the YAML value for the above key must also match this value. Leave empty to match any value.',
  'settings.metadata.floatingButtonCommands': 'Sync Targets',
  'settings.metadata.floatingButtonCommands.desc':
    'Select which content to update when clicking the floating button or triggering auto-sync.',
  'settings.metadata.floatingButtonCommands.noCommands':
    'No commands selected. The floating button will not respond to clicks.',

  // ── v5.2 Auto-Sync ──
  'settings.sync.autoSyncOnOpen': 'Auto-Sync on Open',
  'settings.sync.autoSyncOnOpen.desc':
    'When enabled, opening a note that matches the trigger key above will silently run the selected sync targets below in the background.',
  'notice.autoSyncCompleted': '✅ Literature content auto-synced',
  'notice.autoSyncFailed': '⚠️ Auto-sync failed',


  // ── Notes Tab ──
  'settings.notes.bodyTemplate': 'Body Template',
  'settings.notes.bodyTemplate.desc':
    'Template for the note body. Supports {{placeholder}} syntax. Rendered inside the Zotero content zone below the YAML frontmatter.',
  'settings.notes.importBehavior': 'Import Behavior',

  // ── Citation Tab ──
  'settings.citation.formats': 'Citation Formats',
  'settings.citation.formats.desc':
    'Define citation styles available via commands. Pandoc [@key], LaTeX \\cite{key}, formatted text, or custom template.',
  'settings.citation.suggestTemplate': 'Cite Suggest Template',
  'settings.citation.suggestTemplate.desc':
    'Template inserted when selecting a citation via autocomplete. Use {{citekey}} as placeholder.',

  // ── Legacy keys (kept for backward compatibility) ──
  'settings.template.mappings': 'Property Mappings',
  'settings.template.mappings.desc':
    'Map Zotero fields to Obsidian property keys. Choose a Zotero field and enter the Obsidian property name.',
  'settings.template.addMapping': 'Add Mapping',
  'settings.template.zoteroField': 'Zotero Field',
  'settings.template.obsidianKey': 'Property Name',
  'settings.template.bodyTemplate': 'Body Template',
  'settings.template.bodyTemplate.desc':
    'Markdown body content. Use {{key}} as placeholders — they will be replaced by the corresponding property values.',
  'settings.template.deleteMapping': 'Delete',
};

const zhCN: StringMap = {
  // ── 设置 - 通用 ──
  'settings.general': '通用设置',
  'settings.database': '数据库',
  'settings.database.desc':
    '支持 Zotero 和 Juris-M。也可以手动指定自定义端口号。',
  'settings.port': '端口号',
  'settings.port.desc': '如果已在 Zotero 中设置了自定义端口，请在此输入。',
  'settings.port.placeholder': '示例：23119',
  'settings.noteImportFolder': '笔记导入位置',
  'settings.noteImportFolder.desc':
    '从 Zotero 导入的笔记将存放在此文件夹中',
  'settings.noteImportFolder.placeholder': '示例：文件夹1/文件夹2',
  'settings.storage.heading': '存储与附件',
  'settings.baseStorageFolder': '根存储目录（智能路由）',
  'settings.baseStorageFolder.desc':
    'v3.0：智能多级文件夹路由的根目录。Zotero 的分类目录将作为子文件夹在此根目录下自动创建。',
  'settings.baseStorageFolder.placeholder': '示例：ZoteroLibrary',
  'settings.openAfterImport': '导入后自动打开创建或更新的笔记',
  'settings.openAfterImport.desc':
    '导入所产生的 Markdown 文件将被自动打开。',
  'settings.whichNotesToOpen': '导入后打开哪些笔记',
  'settings.whichNotesToOpen.desc':
    '可以选择打开第一篇导入的笔记、最后一篇导入的笔记，或在新标签页中打开所有笔记。',
  'settings.whichNotes.first': '第一篇导入的笔记',
  'settings.whichNotes.last': '最后一篇导入的笔记',
  'settings.whichNotes.all': '所有导入的笔记',
  'settings.concat': '启用批注拼接',
  'settings.concat.desc':
    '从 PDF 中提取的以 "+" 开头的批注将被追加到前一条批注。注意：批注顺序并非始终一致，拼接结果可能不完全符合预期。',
  'settings.locale': 'Language / 语言',
  'settings.locale.desc': '更改插件设置界面的显示语言。',

  // ── 设置 - 引用格式 ──
  'settings.citeFormats': '引用格式',
  'settings.addCiteFormat': '添加引用格式',

  // ── 设置 - 导入格式 ──
  'settings.importFormats': '导入格式',
  'settings.addImportFormat': '添加导入格式',

  // ── 设置 - 图片 ──
  'settings.imageSettings': '导入图片设置',
  'settings.imageSettings.desc': '矩形批注将以图片形式从 PDF 中提取。',
  'settings.imageFormat': '图片格式',
  'settings.imageQuality': '图片质量（仅 jpg）',
  'settings.imageDPI': '图片 DPI',
  'settings.imageOCR': '图片 OCR',
  'settings.imageOCR.tesseractPath': 'Tesseract 路径',
  'settings.imageOCR.tesseractPath.desc1':
    '必填：tesseract 可执行文件的绝对路径。在 Mac 和 Linux 上可通过终端命令',
  'settings.imageOCR.lang': '图片 OCR 语言',
  'settings.imageOCR.lang.desc1':
    '可选：默认为英文。可以像这样指定多种语言：',
  'settings.imageOCR.lang.desc2': '每种语言都必须已安装在您的系统中。',
  'settings.imageOCR.lang.desc3': '可在此处下载语言包',
  'settings.imageOCR.lang.desc4': '点击此处查看语言代码说明',
  'settings.imageOCR.tessDataDir': 'Tesseract 数据目录',
  'settings.imageOCR.tessDataDir.desc':
    '可选：提供 tesseract 语言文件所在目录的绝对路径。该文件夹应包含所选语言的 *.traineddata 文件。',

  // Image OCR - long description
  'settings.imageOCR.desc.line1':
    '尝试从矩形批注创建的图片中提取文字。这需要在系统中安装',
  'settings.imageOCR.desc.line2': '。可以通过以下方式安装 Tesseract：',
  'settings.imageOCR.desc.line3': 'Mac 上的 homebrew',
  'settings.imageOCR.desc.line4': '、各种 Linux 包管理器，以及',
  'settings.imageOCR.desc.line5': 'Windows 上的此链接',

  // ── 设置 - PDF Utility ──
  'settings.pdfUtility': 'PDF 工具',
  'settings.pdfUtility.desc1': '从 PDF 中提取数据需要外部工具。',
  'settings.pdfUtility.desc2': '没有此工具插件仍可工作，但导出中将不包含批注。',
  'settings.pdfUtility.override': 'PDF 工具路径覆盖',
  'settings.pdfUtility.override.desc1':
    '覆盖 PDF 工具的路径。请指定 pdfannots2json 可执行文件的绝对路径。',
  'settings.pdfUtility.override.desc2': '在此处下载可执行文件。',
  'settings.pdfUtility.override.desc3':
    '您可能需要为 Obsidian 授予相应的操作系统权限以访问该可执行文件。',
  'settings.pdfUtility.upToDate': 'PDF 工具已是最新版本。',
  'settings.pdfUtility.needsUpdate': 'PDF 提取工具需要更新。请重新下载。',
  'settings.pdfUtility.clickToDownload': '点击按钮进行下载。',
  'settings.pdfUtility.download': '下载',
  'settings.pdfUtility.downloading': '下载中...',
  'settings.pdfUtility.findTesseract': '尝试自动查找 tesseract',
  'settings.pdfUtility.findTesseract.fail':
    '无法在系统中找到 tesseract。如已安装，请手动输入路径。',
  'settings.pdfUtility.selectExe': '选择 pdfannots2json 可执行文件',
  'settings.pdfUtility.selectTessDataDir': '选择 tesseract 数据目录',

  // ── 导出格式设置 ──
  'export.name': '名称',
  'export.outputPath': '输出路径',
  'export.outputPath.note': '导出 Markdown 文件的路径。支持模板语法，例如',
  'export.outputPath.note2': '模板可访问 Zotero 条目及其第一个附件的数据。',
  'export.imageOutputPath': '图片输出路径',
  'export.imageOutputPath.note': '图片保存的文件夹。支持模板语法，例如',
  'export.imageBaseName': '图片基础名称',
  'export.imageBaseName.note1': '导出图片的基础文件名。例如',
  'export.imageBaseName.note2': '将生成',
  'export.imageBaseName.note3': '其中',
  'export.imageBaseName.note4': '为页码，',
  'export.imageBaseName.note5': '和',
  'export.imageBaseName.note6':
    '为矩形批注在页面上的 x 和 y 坐标。支持模板语法。模板可访问 Zotero 条目及其第一个附件的数据。',
  'export.templateFile': '模板文件',
  'export.templateFile.note1':
    '在命令面板中打开数据浏览器可查看可用的模板数据。模板使用',
  'export.templateFile.note2': '查看模板文档',
  'export.search': '搜索...',
  'export.style': '参考文献样式',
  'export.style.note': '注意：所选样式必须已在 Zotero 中安装。参见',
  'export.style.note2': 'Zotero：引用样式',
  'export.removeTemplate': '移除模板',
  'export.deprecated.header': '页首模板文件（已弃用）',
  'export.deprecated.annotation': '批注模板文件（已弃用）',
  'export.deprecated.footer': '页脚模板文件（已弃用）',
  'export.deprecated.note': '已弃用：不再需要单独的模板文件。',
  'export.cslSearch': '输入关键词搜索 CSL 样式',
  'export.fileSearch': '输入关键词搜索',

  // ── 引用格式设置 ──
  'cite.name': '名称',
  'cite.outputFormat': '输出格式',
  'cite.template': '模板',
  'cite.template.note1':
    '引用模板可以访问 Zotero 条目数据的子集。条目的第一个附件可在',
  'cite.template.note2':
    '键下访问。不提供批注数据。在命令面板中打开数据浏览器可查看可用的模板数据。模板使用',
  'cite.style.citation': '引用样式',
  'cite.style.bibliography': '参考文献样式',
  'cite.style.note': '注意：所选样式必须已在 Zotero 中安装。参见',
  'cite.style.note2': 'Zotero：引用样式',
  'cite.command': '引用命令',
  'cite.brackets': '包含括号',

  // ── Data Explorer ──
  'dataExplorer.prompt': '选择条目',
  'dataExplorer.preview': '预览导入格式',
  'dataExplorer.noData': '未获取到数据',
  'dataExplorer.title': 'Zotero 数据浏览器',
  'dataExplorer.copyPath': '复制模板路径',
  'dataExplorer.copyLoop': '复制循环模板',
  'dataExplorer.templateData': '模板数据',

  // ── 命令名称 ──
  'command.insertNotes': '将笔记插入当前文档',
  'command.importNotes': '导入为独立笔记',
  'command.dataExplorer': '数据浏览器',
  'command.quickImport': '快速导入',
  'command.updateMetadata': '更新条目信息',
  'command.syncAnnotations': '更新批注笔记',
  'command.copyCitation': '复制引注占位符到剪贴板',
  'command.insertItemInfo': '插入条目信息（YAML）',
  'command.insertAnnotations': '插入批注笔记',
  'command.insertBibliography': '插入参考文献',

  // ── 模态框 / 提示 ──
  'modal.fetchingData': '正在从 Zotero 获取数据...',
  'modal.fetchingNotes': '正在从 Zotero 获取笔记...',
  'modal.fetchingCollections': '正在从 Zotero 获取收藏集...',
  'modal.awaitingSelection': '等待从 Zotero 选择条目...',
  'modal.extractingAnnotations': '正在提取批注...',
  'modal.updatingPDFUtility': '正在更新 Obsidian Zotero Integration PDF 工具...',

  // ── 通知 / 错误 ──
  'notice.zoteroNotRunning':
    '无法连接到 Zotero。请确保 Zotero 正在运行且已安装 Better BibTeX 插件',
  'notice.citationError': '处理引用时出错：',
  'notice.citeKeyError': '获取引用键时出错：',
  'notice.noNotesFound': '未在选中的条目中找到笔记',
  'notice.importFailed': '%s 导入失败，详情请查看开发者控制台',
  'notice.errorCreatingFile': '创建文件 "%s" 时出错：',
  'notice.errorRetrievingNotes': '获取笔记时出错：',
  'notice.errorRetrievingBib': '获取格式化参考文献时出错：',
  'notice.errorRetrievingItem': '获取条目数据时出错：',
  'notice.errorRetrievingLibraryId': '获取库 ID 时出错：',
  'notice.errorSearching': '搜索时出错：',
  'notice.emptyBib':
    '错误：从 Zotero 收到空的参考文献。请确保 Zotero 的快速复制设置已配置且所选的引用样式已安装。',
  'notice.convertError': '将格式化参考文献转换为 Markdown 时出错：',
  'notice.pdfPassword': '无法打开 %s：PDF 受密码保护',
  'notice.pdfNotExecutable': '错误：PDF 工具不可执行',
  'notice.pdfProcessingError': '处理 PDF 时出错：',
  'notice.pdfAnnotationError': '处理批注时出错：',
  'notice.pdfDownloadError': '下载 PDF 工具时出错。请查看控制台了解详情。',
  'notice.pdfVersionError': '检查 PDF 工具版本时出错：',
  'notice.cannotCopyImage':
    '错误：无法将批注图片从 Zotero 复制到您的 vault',
  'notice.templateNotFound': '错误：%s 模板未找到 %s',
  'notice.importFormatNotFound': '错误：未找到导入格式 "%s"',
  'notice.noTemplates': '未找到导出格式 %s 的模板',
  'notice.metadataUpdated': '已更新 %s 个文件的元数据 YAML。',
  'notice.annotationsSynced': '已同步 %s 个文件的笔记与批注。',
  'notice.citationCopied': '引注 "%s" 已复制到剪贴板。',
  'notice.noFilesToUpdate':
    '未找到已有文件，请先执行一次完整导入。',
  'notice.noCitationReturned': '未从 Zotero 获取到引注数据。',
  'notice.itemInfoInserted': '已插入 %s 个条目的 YAML 信息。',
  'notice.annotationsInserted': '已插入 %s 个条目的笔记。',
  'notice.bibInserted': '已插入 %s 个条目的参考文献。',

  // ── 模板错误 ──
  'error.parsingTemplate': '解析模板 "%s" 时出错：',
  'error.cannotFindFile': '找不到文件。无效的 Markdown 链接：',
  'error.fileNotFound': '找不到文件。文件不存在：',

  // ── 影响因子颜色配置 ──
  'settings.ifColorRules': '影响因子颜色配置',
  'settings.ifColorRules.desc':
    '根据影响因子数值范围，在属性面板中为 IF 标签动态着色。',
  'settings.ifColorRules.add': '添加规则',
  'settings.ifColorRules.min': '最小值',
  'settings.ifColorRules.max': '最大值（留空为无穷大）',
  'settings.ifColorRules.bgColor': '背景色',
  'settings.ifColorRules.textColor': '字体色',
  'settings.ifColorRules.delete': '删除',
  'settings.ifColorRules.preview': '预览',

  // ── 标题跑马灯 ──
  'settings.titleMarquee': '文献标题显示',
  'settings.titleMarquee.desc':
    '为属性面板中的长标题添加水平滚动动画，完整展示标题文字。',
  'settings.titleMarquee.enable': '启用标题跑马灯',
  'settings.titleMarquee.enable.desc':
    '开启后，长标题将自动水平滚动以展示完整文字。',
  'settings.titleMarquee.duration': '滚动周期（秒）',
  'settings.titleMarquee.duration.desc':
    '完成一次完整滚动所需的秒数。默认：15 秒。',

  // ── v4.0 工作流导向 Tab ──
  'settings.tab.metadata': '元数据映射',
  'settings.tab.notes': '笔记模板',
  'settings.tab.citation': '引注格式',
  'settings.tab.sync': '更新同步',

  // ── System Header ──
  'settings.system': '系统设置',
  'settings.advanced': '高级设置（图片与OCR）',

  // ── Metadata Tab ──
  'settings.metadata.propertyMappings': '属性映射',
  'settings.metadata.propertyMappings.desc':
    '将 Zotero 字段映射到 Obsidian YAML 属性。拖拽 ⋮⋮ 排序。这些映射会成为每篇导入笔记的 frontmatter。',
  'settings.metadata.customProperties': '本地自定义属性',
  'settings.metadata.customProperties.desc':
    '定义专属 Obsidian 的静态属性及默认值。新建笔记时自动写入，增量更新时绝不覆盖。',
  'settings.metadata.propertyItems': '属性列表',
  'settings.metadata.propertyItems.desc':
    'Zotero 字段映射与自定义属性的统一列表。拖拽 ⋮⋮ 排序，通过类型选择器切换每行的属性种类。',
  'settings.metadata.propertyItems.empty': '尚未添加属性',
  'settings.metadata.propertyItems.add': '添加属性',
  'settings.metadata.propertyItems.addZotero': '添加 Zotero 字段',
  'settings.metadata.propertyItems.addCustom': '添加自定义属性',
  'settings.metadata.propertyItems.kind': '类型',
  'settings.metadata.propertyItems.kindZotero': 'Zotero 字段',
  'settings.metadata.propertyItems.kindCustom': '自定义',
  'settings.metadata.customProperties.key': '属性名',
  'settings.metadata.customProperties.value': '默认值',
  'settings.metadata.triggerFeatureKey': '悬浮球触发特征键',
  'settings.metadata.triggerFeatureKey.desc':
    '仅当当前笔记的 YAML 中包含此键时，才判定为文献笔记并显示悬浮同步球。默认：文献标题。',
  'settings.metadata.triggerFeatureValue': '悬浮球触发特征值',
  'settings.metadata.triggerFeatureValue.desc':
    '可选：设置后，YAML 中对应键的值必须与此值匹配才触发悬浮球。留空则匹配任意值。',
  'settings.metadata.floatingButtonCommands': '执行同步内容',
  'settings.metadata.floatingButtonCommands.desc':
    '请选择在点击悬浮球或触发自动同步时，需要更新哪些具体内容。',
  'settings.metadata.floatingButtonCommands.noCommands':
    '未选择任何命令，点击悬浮球将无反应。',

  // ── v5.2 开卷自动同步 ──
  'settings.sync.autoSyncOnOpen': '开卷自动同步',
  'settings.sync.autoSyncOnOpen.desc':
    '开启后，每次打开符合上述特征键的笔记时，将在后台静默自动执行下方勾选的同步内容。',
  'notice.autoSyncCompleted': '✅ 文献内容已自动同步',
  'notice.autoSyncFailed': '⚠️ 自动同步失败',


  // ── Notes Tab ──
  'settings.notes.bodyTemplate': '正文模板',
  'settings.notes.bodyTemplate.desc':
    '笔记正文模板。支持 {{placeholder}} 语法。渲染后置于 YAML frontmatter 下方的 Zotero 内容区域内。',
  'settings.notes.importBehavior': '导入行为',

  // ── Citation Tab ──
  'settings.citation.formats': '引注格式',
  'settings.citation.formats.desc':
    '定义通过命令面板可用的引注样式。支持 Pandoc [@key]、LaTeX \\cite{key}、格式化文本或自定义模板。',
  'settings.citation.suggestTemplate': '自动补全模板',
  'settings.citation.suggestTemplate.desc':
    '通过自动补全选择引用时插入的模板。使用 {{citekey}} 作为占位符。',

  // ── Legacy keys ──
  'settings.template.mappings': '属性映射',
  'settings.template.mappings.desc':
    '将 Zotero 字段映射到 Obsidian 属性键。选择一个 Zotero 字段并输入 Obsidian 属性名称。',
  'settings.template.addMapping': '添加映射',
  'settings.template.zoteroField': 'Zotero 字段',
  'settings.template.obsidianKey': '属性名称',
  'settings.template.bodyTemplate': '正文模板',
  'settings.template.bodyTemplate.desc':
    '正文 Markdown 内容。使用 {{key}} 作为占位符——它们会被对应属性值替换。',
  'settings.template.deleteMapping': '删除',
};

// ─── 翻译函数 ─────────────────────────────────────────────────────

/**
 * 获取当前语言的翻译字符串。
 * 支持简单的 %s 占位符替换。
 *
 * @param key   - 字符串键
 * @param args - 可选，替换 %s 占位符的参数
 */
export function t(key: string, ...args: string[]): string {
  const map = currentLocale === 'zh-cn' ? zhCN : en;
  let str = map[key];

  // 如果当前语言没有翻译，回退到英文
  if (str === undefined) {
    str = en[key];
  }

  // 如果还是没有，返回 key 本身（方便调试）
  if (str === undefined) {
    return key;
  }

  // 替换占位符
  for (const arg of args) {
    str = str.replace('%s', arg);
  }

  return str;
}

/**
 * 获取所有语言选项（用于下拉菜单）
 */
export function getLocaleOptions(): { value: Locale; label: string }[] {
  return [
    { value: 'en', label: 'English' },
    { value: 'zh-cn', label: '简体中文' },
  ];
}
