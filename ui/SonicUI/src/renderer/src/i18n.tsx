/* eslint-disable react-refresh/only-export-components -- provider and hook intentionally share this module. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Locale = 'en' | 'ur'
type MessageKey =
  | 'settings'
  | 'openSettings'
  | 'closeWindow'
  | 'minimizeWindow'
  | 'maximizeWindow'
  | 'downloads'
  | 'newDownload'
  | 'batchImport'
  | 'searchDownloads'
  | 'sortDownloads'
  | 'all'
  | 'inProgress'
  | 'finished'
  | 'failed'
  | 'history'
  | 'networks'
  | 'addDownload'
  | 'downloadLink'
  | 'destination'
  | 'chooseFolder'
  | 'startDownload'
  | 'cancel'
  | 'save'
  | 'saving'
  | 'resetDefaults'
  | 'language'
  | 'languageDescription'
  | 'english'
  | 'urdu'
  | 'settingsSaved'
  | 'keyboardHelp'
  | 'downloadSchedule'
  | 'downloadsAtOnce'
  | 'backupStorage'
  | 'exportBackup'
  | 'restoreBackup'
  | 'remoteControl'
  | 'plugins'
  | 'close'
  | 'sortNewest'
  | 'sortOldest'
  | 'sortName'
  | 'sortSize'
  | 'noDownloads'
  | 'selectAll'
  | 'clearSelection'
  | 'accessibility'
  | 'accessibilityDescription'
  | 'importLinks'
  | 'mirrorSite'
  | 'activeNetworks'
  | 'noActiveNetwork'

const messages: Record<Locale, Record<MessageKey, string>> = {
  en: {
    settings: 'Settings',
    openSettings: 'Open settings',
    closeWindow: 'Close window',
    minimizeWindow: 'Minimize window',
    maximizeWindow: 'Maximize or restore window',
    downloads: 'Downloads',
    newDownload: 'New download',
    batchImport: 'Batch import',
    searchDownloads: 'Search downloads',
    sortDownloads: 'Sort downloads',
    all: 'All',
    inProgress: 'In progress',
    finished: 'Finished',
    failed: 'Failed',
    history: 'History',
    networks: 'Networks',
    addDownload: 'Add download',
    downloadLink: 'Download link',
    destination: 'Destination',
    chooseFolder: 'Choose folder',
    startDownload: 'Start download',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    resetDefaults: 'Reset to defaults',
    language: 'Language',
    languageDescription: 'Choose the display language. Urdu enables right-to-left layout.',
    english: 'English',
    urdu: 'اردو',
    settingsSaved: 'Settings saved',
    keyboardHelp: 'Keyboard navigation',
    downloadSchedule: 'Download schedule',
    downloadsAtOnce: 'Downloads at once',
    backupStorage: 'Backup and storage',
    exportBackup: 'Export backup',
    restoreBackup: 'Restore backup',
    remoteControl: 'Local Wi-Fi remote control',
    plugins: 'Plugins',
    close: 'Close',
    sortNewest: 'Newest first',
    sortOldest: 'Oldest first',
    sortName: 'Name',
    sortSize: 'Size',
    noDownloads: 'No downloads yet',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
    accessibility: 'Accessibility',
    accessibilityDescription:
      'Keyboard focus, screen-reader labels, reduced motion and scalable text are supported.',
    importLinks: 'Import links',
    mirrorSite: 'Mirror site',
    activeNetworks: 'Active networks',
    noActiveNetwork: 'No active network'
  },
  ur: {
    settings: 'ترتیبات',
    openSettings: 'ترتیبات کھولیں',
    closeWindow: 'ونڈو بند کریں',
    minimizeWindow: 'ونڈو چھوٹی کریں',
    maximizeWindow: 'ونڈو بڑی یا بحال کریں',
    downloads: 'ڈاؤن لوڈز',
    newDownload: 'نیا ڈاؤن لوڈ',
    batchImport: 'متعدد لنکس شامل کریں',
    searchDownloads: 'ڈاؤن لوڈز تلاش کریں',
    sortDownloads: 'ڈاؤن لوڈز ترتیب دیں',
    all: 'تمام',
    inProgress: 'جاری',
    finished: 'مکمل',
    failed: 'ناکام',
    history: 'تاریخچہ',
    networks: 'نیٹ ورکس',
    addDownload: 'ڈاؤن لوڈ شامل کریں',
    downloadLink: 'ڈاؤن لوڈ لنک',
    destination: 'محفوظ کرنے کی جگہ',
    chooseFolder: 'فولڈر منتخب کریں',
    startDownload: 'ڈاؤن لوڈ شروع کریں',
    cancel: 'منسوخ',
    save: 'محفوظ کریں',
    saving: 'محفوظ ہو رہا ہے…',
    resetDefaults: 'طے شدہ ترتیبات بحال کریں',
    language: 'زبان',
    languageDescription: 'ظاہری زبان منتخب کریں۔ اردو میں دائیں سے بائیں ترتیب فعال ہوتی ہے۔',
    english: 'English',
    urdu: 'اردو',
    settingsSaved: 'ترتیبات محفوظ ہو گئیں',
    keyboardHelp: 'کی بورڈ سے نیویگیشن',
    downloadSchedule: 'ڈاؤن لوڈ کا شیڈول',
    downloadsAtOnce: 'بیک وقت ڈاؤن لوڈز',
    backupStorage: 'بیک اپ اور اسٹوریج',
    exportBackup: 'بیک اپ برآمد کریں',
    restoreBackup: 'بیک اپ بحال کریں',
    remoteControl: 'مقامی وائی فائی ریموٹ کنٹرول',
    plugins: 'پلگ اِنز',
    close: 'بند کریں',
    sortNewest: 'نئے پہلے',
    sortOldest: 'پرانے پہلے',
    sortName: 'نام',
    sortSize: 'سائز',
    noDownloads: 'ابھی کوئی ڈاؤن لوڈ نہیں',
    selectAll: 'سب منتخب کریں',
    clearSelection: 'انتخاب ختم کریں',
    accessibility: 'رسائی پذیری',
    accessibilityDescription:
      'کی بورڈ فوکس، اسکرین ریڈر لیبل، کم حرکت اور متن کا سائز بڑھانے کی سہولت موجود ہے۔',
    importLinks: 'لنکس درآمد کریں',
    mirrorSite: 'ویب سائٹ کی نقل',
    activeNetworks: 'فعال نیٹ ورکس',
    noActiveNetwork: 'کوئی فعال نیٹ ورک نہیں'
  }
}

// Literal-string fallback keeps older and less frequently used screens localizable while they
// migrate to stable message keys. English falls back to the source string; Urdu uses this catalog.
const literalUrdu: Record<string, string> = {
  Priority: 'ترجیح',
  Low: 'کم',
  Normal: 'عام',
  High: 'زیادہ',
  'Receive cap': 'ڈاؤن لوڈ حد',
  'Upload cap': 'اپ لوڈ حد',
  'Upload ratio': 'اپ لوڈ تناسب',
  Unlimited: 'لامحدود',
  'Do not seed after completion':
    '\u0688\u0627\u0624\u0646 \u0644\u0648\u0688 \u0645\u06a9\u0645\u0644 \u06c1\u0648\u0646\u06d2 \u06a9\u06d2 \u0628\u0639\u062f \u0633\u06cc\u0688 \u0646\u06c1 \u06a9\u0631\u06cc\u06ba',
  'Keep seeding until stopped':
    '\u0631\u0648\u06a9\u0646\u06d2 \u062a\u06a9 \u0633\u06cc\u0688 \u06a9\u0631\u062a\u06d2 \u0631\u06c1\u06cc\u06ba',
  'No action': 'کوئی عمل نہیں',
  'Show a notification': 'اطلاع دکھائیں',
  'Open the completed file': 'مکمل فائل کھولیں',
  'Paste a new link': 'نیا لنک چسپاں کریں',
  'Mirror site - dry run': 'مرر سائٹ — آزمائشی جائزہ',
  Color: 'رنگ',
  'Only your default network can be used': 'صرف طے شدہ نیٹ ورک استعمال ہو سکتا ہے',
  Quality: 'معیار',
  'per network': 'فی نیٹ ورک',
  'Checking the link…': 'لنک چیک ہو رہا ہے…',
  'Save to': 'یہاں محفوظ کریں',
  Change: 'تبدیل کریں',
  Networks: 'نیٹ ورکس',
  Streams: 'اسٹریمز',
  'Paste a link manifest or copied HTML directory listing, or load a text file. Supports HTTP(S), magnet links and local .torrent paths. Relative listing links require a base URL and are restricted to that origin; folders are not crawled. Review items before queueing.':
    'لنکس کی فہرست یا کاپی شدہ HTML ڈائریکٹری لسٹنگ چسپاں کریں، یا متن کی فائل لوڈ کریں۔ HTTP(S)، میگنیٹ لنکس اور مقامی .torrent راستے معاون ہیں۔ متعلقہ لنکس کے لیے بنیادی URL ضروری ہے؛ فولڈرز خودکار طور پر نہیں کھنگالے جاتے۔ قطار میں شامل کرنے سے پہلے جائزہ لیں۔',
  'Directory-listing base URL (optional; relative file links only)':
    'ڈائریکٹری لسٹنگ کا بنیادی URL (اختیاری؛ صرف متعلقہ فائل لنکس)',
  'Preview links': 'لنکس کا پیش نظارہ',
  'Add selected to queue': 'منتخب لنکس قطار میں شامل کریں',
  'Retry failed checks': 'ناکام جانچ دوبارہ کریں',
  'Close import': 'درآمد بند کریں',
  'Download links, one per line or pasted text': 'ڈاؤن لوڈ لنکس، ہر سطر میں ایک یا چسپاں متن',
  'Unsupported or invalid link. Use HTTP(S), magnet, or a local .torrent path.':
    'لنک غیر معاون یا غلط ہے۔ HTTP(S)، میگنیٹ یا مقامی .torrent راستہ استعمال کریں۔',
  'No valid links to preview.': 'پیش نظارہ کے لیے کوئی درست لنک نہیں۔',
  'Choose a destination folder first.': 'پہلے محفوظ کرنے کا فولڈر منتخب کریں۔',
  'Select at least one successfully checked link to add to the queue.':
    'قطار میں شامل کرنے کے لیے کم از کم ایک کامیابی سے جانچا گیا لنک منتخب کریں۔',
  'No plugins installed.': 'کوئی پلگ اِن نصب نہیں۔',
  'Plugin API': 'پلگ اِن API',
  'Trust a signer key': 'دستخط کنندہ کی کلید پر اعتماد کریں',
  'Review signed plugin manifest': 'دستخط شدہ پلگ اِن مینی فیسٹ کا جائزہ لیں',
  'Installed plugins': 'نصب شدہ پلگ اِنز',
  'Local Wi-Fi remote control': 'مقامی وائی فائی ریموٹ کنٹرول',
  'HTTPS listener active': 'HTTPS سننے کی سروس فعال ہے',
  'Pair a phone': 'فون جوڑیں',
  'Paired devices': 'جوڑے گئے آلات',
  'No active paired phones.': 'کوئی فعال جوڑا ہوا فون نہیں۔',
  'Recent remote activity': 'حالیہ ریموٹ سرگرمی',
  'Download schedule': 'ڈاؤن لوڈ کا شیڈول',
  'Next day': 'اگلا دن',
  Optional: 'اختیاری',
  Total: 'کل',
  'Slow drive': 'سست ڈرائیو',
  'Your drive can’t save any faster, so this download is going slower.':
    'ڈرائیو اس سے تیز محفوظ نہیں کر سکتی، اس لیے ڈاؤن لوڈ سست ہے۔',
  'Waiting for a network. Reconnect one or switch one on.':
    'نیٹ ورک کا انتظار ہے۔ دوبارہ منسلک کریں یا نیٹ ورک فعال کریں۔',
  'Can’t reach peers. Retrying…': 'پیئرز تک رسائی نہیں ہو سکی۔ دوبارہ کوشش ہو رہی ہے…',
  'Can’t reach the server. Retrying…': 'سرور تک رسائی نہیں ہو سکی۔ دوبارہ کوشش ہو رہی ہے…',
  'Every network in use has reached its data limit. Raise one in Speed & data limits.':
    'استعمال میں موجود ہر نیٹ ورک ڈیٹا حد تک پہنچ گیا ہے۔ رفتار اور ڈیٹا حدود میں حد بڑھائیں۔',
  Folder: 'فولڈر',
  'Saving to': 'یہاں محفوظ ہو رہا ہے',
  'No downloads yet': 'ابھی کوئی ڈاؤن لوڈ نہیں',
  'No networks connected': 'کوئی نیٹ ورک منسلک نہیں',
  'Network settings': 'نیٹ ورک ترتیبات',
  'Scan again': 'دوبارہ تلاش کریں',
  'Paste a link': 'لنک چسپاں کریں',
  'Open .torrent': '.torrent کھولیں',
  Cancel: 'منسوخ کریں',
  Download: 'ڈاؤن لوڈ',
  Starting: 'شروع ہو رہا ہے',
  Checking: 'جانچ جاری ہے',
  'Download media': 'میڈیا ڈاؤن لوڈ کریں',
  'Add to queue': 'قطار میں شامل کریں',
  'Add to scheduled queue': 'شیڈول قطار میں شامل کریں',
  'Resume it': 'اسے دوبارہ جاری کریں',
  'Previous download': 'پچھلا ڈاؤن لوڈ',
  'Next download': 'اگلا ڈاؤن لوڈ',
  'File name': 'فائل کا نام',
  'Alternate mirror URLs': 'متبادل مرر URLs',
  'Download media stream': 'میڈیا اسٹریم ڈاؤن لوڈ کریں',
  'Media stream quality': 'میڈیا اسٹریم معیار',
  'Active networks': 'فعال نیٹ ورکس',
  'No network interfaces with an assigned address.':
    'کسی نیٹ ورک انٹرفیس کو ایڈریس تفویض نہیں ہوا۔',
  'Waiting for a turn': 'باری کا انتظار ہے',
  Queued: 'قطار میں',
  Paused: 'موقوف',
  Finished: 'مکمل',
  'In progress': 'جاری',
  Failed: 'ناکام',
  History: 'سابقہ ریکارڈ',
  All: 'تمام',
  'Newest first': 'نئے پہلے',
  'Oldest first': 'پرانے پہلے',
  Name: 'نام',
  Size: 'سائز',
  Search: 'تلاش',
  'Search downloads': 'ڈاؤن لوڈز تلاش کریں',
  'Sort downloads': 'ڈاؤن لوڈز ترتیب دیں',
  'Clear finished list': 'مکمل فہرست صاف کریں',
  'Download history': 'ڈاؤن لوڈ تاریخچہ',
  'Finished, in-progress, queued and paused downloads': 'مکمل، جاری، قطار میں اور موقوف ڈاؤن لوڈز',
  'No download history yet.': 'ابھی ڈاؤن لوڈ تاریخچہ موجود نہیں۔',
  'Show in folder': 'فولڈر میں دکھائیں',
  'Show in Finder': 'Finder میں دکھائیں',
  'Reset settings to defaults?': 'ترتیبات ابتدائی حالت پر بحال کریں؟',
  'Settings saved': 'ترتیبات محفوظ ہو گئیں',
  'Open settings': 'ترتیبات کھولیں',
  'Close window': 'ونڈو بند کریں',
  'Minimize window': 'ونڈو چھوٹی کریں',
  'Maximize or restore window': 'ونڈو بڑی کریں یا بحال کریں',
  'Batch import': 'متعدد لنکس شامل کریں',
  'Export backup': 'بیک اپ برآمد کریں',
  'Restore backup': 'بیک اپ بحال کریں',
  Accessibility: 'رسائی پذیری',
  'Keyboard navigation': 'کی بورڈ نیویگیشن'
}

const literalUrduMore: Record<string, string> = {
  Downloads: 'ڈاؤن لوڈز',
  'Download complete': 'ڈاؤن لوڈ مکمل',
  AVERAGE: 'اوسط',
  Size: 'سائز',
  Time: 'وقت',
  Peak: 'زیادہ سے زیادہ',
  Peers: 'پیئرز',
  'Speed over the download': 'ڈاؤن لوڈ کے دوران رفتار',
  'Contribution by network': 'نیٹ ورک کے لحاظ سے حصہ',
  'Local SHA-256': 'مقامی SHA-256',
  'selected-file tree': 'منتخب فائلوں کا درخت',
  file: 'فائل',
  'Computed from the saved output; not a publisher-provided checksum.':
    'محفوظ شدہ فائل سے حساب کیا گیا؛ ناشر کی فراہم کردہ چیک سم نہیں۔',
  'Copy SHA-256': 'SHA-256 کاپی کریں',
  'Download cancelled': 'ڈاؤن لوڈ منسوخ',
  'Download failed': 'ڈاؤن لوڈ ناکام',
  'The download was stopped before finishing.': 'ڈاؤن لوڈ مکمل ہونے سے پہلے روک دیا گیا۔',
  'The download stopped unexpectedly. Try again.':
    'ڈاؤن لوڈ غیر متوقع طور پر رک گیا۔ دوبارہ کوشش کریں۔',
  Unavailable: 'دستیاب نہیں',
  'Could not save the diagnostic report. Check the destination and permissions, then try again.':
    'تشخیصی رپورٹ محفوظ نہیں ہو سکی۔ منزل اور اجازتیں چیک کرکے دوبارہ کوشش کریں۔',
  Pause: 'موقوف کریں',
  Paused: 'موقوف',
  Pausing: 'موقوف کیا جا رہا ہے',
  Resume: 'دوبارہ شروع کریں',
  Resuming: 'دوبارہ شروع ہو رہا ہے',
  Retry: 'دوبارہ کوشش کریں',
  Retrying: 'دوبارہ کوشش جاری ہے',
  'Fix link': 'لنک درست کریں',
  'Download again': 'دوبارہ ڈاؤن لوڈ کریں',
  Open: 'کھولیں',
  'Copy link': 'لنک کاپی کریں',
  'Cancel download': 'ڈاؤن لوڈ منسوخ کریں',
  'Remove from list': 'فہرست سے ہٹائیں',
  'Stop sharing this completed torrent and move it to history':
    'اس مکمل ٹورینٹ کی شیئرنگ روک کر تاریخچے میں منتقل کریں',
  'Choose which queued download starts first':
    'منتخب کریں کہ قطار میں کون سا ڈاؤن لوڈ پہلے شروع ہو',
  'Limit the combined receive speed of this download':
    'اس ڈاؤن لوڈ کی مجموعی وصولی رفتار محدود کریں',
  'Limit the upload speed for this torrent only': 'صرف اس ٹورینٹ کی اپ لوڈ رفتار محدود کریں',
  'Stop uploading when uploaded bytes reach this multiple of downloaded bytes':
    'اپ لوڈ ڈیٹا ڈاؤن لوڈ ڈیٹا کے اس تناسب تک پہنچنے پر روکیں',
  'Ratio reached': 'تناسب حاصل ہو گیا',
  'Refresh trackers': 'ٹریکروں کو تازہ کریں',
  'Refreshing…': 'تازہ ہو رہا ہے…',
  'Stop seeding': 'سیڈنگ روکیں',
  Tracker: 'ٹریکَر',
  "Set this file's download priority": 'اس فائل کی ڈاؤن لوڈ ترجیح مقرر کریں',
  Preview: 'پیش نظارہ',
  'while downloading': 'ڈاؤن لوڈ کے دوران',
  Skipped: 'چھوڑ دیا گیا',
  Done: 'مکمل',
  'Keep at least one file.': 'کم از کم ایک فائل رکھیں۔',
  'Custom trackers (one URL per line)': 'حسب ضرورت ٹریکرز (ہر سطر میں ایک URL)',
  'Apply trackers': 'ٹریکرز لاگو کریں',
  'Up to 20 HTTP(S)/UDP URLs; blank removes custom entries.':
    'زیادہ سے زیادہ 20 HTTP(S)/UDP URLs؛ خالی رکھنے سے حسب ضرورت اندراجات ہٹ جائیں گے۔',
  Enabled: 'فعال',
  'Start at': 'شروع کا وقت',
  'Stop at': 'اختتامی وقت',
  'Repeat on': 'ان دنوں دہرائیں',
  'Schedule times and days': 'شیڈول کے اوقات اور دن',
  'End date': 'اختتامی تاریخ',
  'No end date': 'اختتامی تاریخ نہیں',
  Clear: 'صاف کریں',
  'Choose end date': 'اختتامی تاریخ منتخب کریں',
  'Edit network': 'نیٹ ورک میں ترمیم',
  Name: 'نام',
  'Download queue priority': 'ڈاؤن لوڈ قطار کی ترجیح',
  'Download receive speed limit': 'ڈاؤن لوڈ وصولی رفتار کی حد',
  'Torrent upload speed limit': 'ٹورینٹ اپ لوڈ رفتار کی حد',
  'Torrent upload ratio limit': 'ٹورینٹ اپ لوڈ تناسب کی حد',
  'Preview file while downloading': 'ڈاؤن لوڈ کے دوران فائل کا پیش نظارہ',
  'Open test.bin': 'test.bin کھولیں',
  'Import multiple downloads': 'متعدد ڈاؤن لوڈ درآمد کریں',
  'Pairing code': 'جوڑنے کا کوڈ',
  'HTTPS listener': 'HTTPS سننے والا عمل',
  'Copy pairing URL': 'جوڑنے کا URL کاپی کریں',
  'Unpair device': 'آلہ الگ کریں',
  'Never share outside your local Wi-Fi': 'اپنے مقامی وائی فائی سے باہر شیئر نہ کریں',
  'The local remote control listens only on your local network.':
    'مقامی ریموٹ کنٹرول صرف آپ کے مقامی نیٹ ورک پر سنتا ہے۔',
  'Trust a signer key': 'دستخط کنندہ کی کلید پر اعتماد کریں',
  'Review signed plugin manifest': 'دستخط شدہ پلگ اِن مینی فیسٹ کا جائزہ لیں',
  'No plugins installed.': 'کوئی پلگ اِن نصب نہیں۔',
  'Mirror site - dry run': 'مرر سائٹ — آزمائشی جائزہ',
  'Download priority': 'ڈاؤن لوڈ ترجیح',
  'Choose folder': 'فولڈر منتخب کریں',
  'Current progress': 'موجودہ پیش رفت',
  'No download history yet.': 'ابھی ڈاؤن لوڈ تاریخچہ موجود نہیں۔',
  Files: 'فائلیں',
  'Priority for': 'ترجیح برائے',
  'Applying…': 'لاگو ہو رہا ہے…',
  'TOTAL SPEED': 'کل رفتار',
  AVG: 'اوسط',
  PEAK: 'بلند ترین',
  THROUGHPUT: 'ڈیٹا کی رفتار',
  LAST: 'گزشتہ',
  left: 'باقی',
  retry: 'دوبارہ کوشش',
  retries: 'دوبارہ کوششیں',
  peer: 'پیئر',
  peers: 'پیئرز',
  Folder: 'فولڈر',
  'Saving to:': 'یہاں محفوظ ہو رہا ہے:',
  'Refresh peer discovery from configured trackers': 'ترتیب شدہ ٹریکرز سے پیئرز کی تلاش تازہ کریں',
  'Every network in use has reached its data limit. Raise one in Speed & data limits.':
    'استعمال میں موجود ہر نیٹ ورک ڈیٹا حد تک پہنچ گیا ہے۔ رفتار اور ڈیٹا حدود میں حد بڑھائیں۔',
  'Preview links': 'لنکس کا پیش نظارہ',
  'Add selected to queue': 'منتخب قطار میں شامل کریں',
  'Retry failed checks': 'ناکام جانچ دوبارہ کریں',
  'Close import': 'درآمد بند کریں',
  'Next day': 'اگلا دن',
  'Schedule days': 'شیڈول کے دن',
  'Batch import': 'متعدد لنکس شامل کریں',
  'Paste a link manifest or copied HTML directory listing, or load a text file. Supports HTTP(S), magnet links and local .torrent paths. Relative listing links require a base URL and are restricted to that origin; folders are not crawled. Review items before queueing.':
    'لنکس کی فہرست یا کاپی شدہ HTML ڈائریکٹری لسٹنگ چسپاں کریں، یا متن کی فائل لوڈ کریں۔ HTTP(S)، میگنیٹ لنکس اور مقامی .torrent راستے معاون ہیں۔ متعلقہ لنکس کے لیے بنیادی URL ضروری ہے؛ فولڈرز خودکار طور پر نہیں کھنگالے جاتے۔ قطار میں شامل کرنے سے پہلے جائزہ لیں۔',
  'Pair a phone': 'فون جوڑیں',
  'Paired devices': 'جوڑے گئے آلات',
  'Recent remote activity': 'حالیہ ریموٹ سرگرمی',
  'No active paired phones.': 'کوئی فعال جوڑا ہوا فون نہیں۔',
  LIMIT: 'حد',
  'SLOW MODE': 'سست موڈ',
  'written in': 'لکھے گئے',
  pieces: 'ٹکڑے',
  chunks: 'حصے',
  uploaded: 'اپ لوڈ شدہ',
  'moved or deleted since': 'اس کے بعد منتقل یا حذف ہوئی',
  Link: 'لنک',
  'Adding…': 'شامل ہو رہا ہے…',
  'Checking…': 'جانچ ہو رہی ہے…',
  'Destination changed. Preview links again before queueing.':
    'محفوظ کرنے کی جگہ بدل گئی۔ قطار میں شامل کرنے سے پہلے لنکس کا پیش نظارہ دوبارہ دیکھیں۔',
  'Enable download schedule': 'ڈاؤن لوڈ شیڈول فعال کریں',
  hour: 'گھنٹہ',
  minute: 'منٹ',
  Sun: 'اتوار',
  Mon: 'پیر',
  Tue: 'منگل',
  Wed: 'بدھ',
  Thu: 'جمعرات',
  Fri: 'جمعہ',
  Sat: 'ہفتہ',
  Teal: 'سبز مائل نیلا',
  Amber: 'عنبر',
  Steel: 'اسٹیل',
  Rose: 'گلابی',
  Violet: 'بنفشی',
  Lime: 'لیموں سبز',
  Cyan: 'فیروزی',
  Coral: 'مرجانی',
  'Clear link': 'لنک صاف کریں',
  'Metalink file': 'میٹا لنک فائل',
  'Alternate mirrors (optional, one URL per line)': 'متبادل مرر (اختیاری، ہر سطر میں ایک URL)',
  'Alternate mirror URLs': 'متبادل مرر URLs',
  'Open .torrent': '.torrent کھولیں',
  'On-demand, non-DRM stream · FFmpeg required': 'آن ڈیمانڈ، غیر DRM اسٹریم · FFmpeg ضروری ہے',
  'Sonic only uses mirrors that match the primary file size, support ranges, and share its strong ETag. Maximum four mirrors.':
    'سونک صرف ایسے مرر استعمال کرتا ہے جن کی بنیادی فائل کا سائز ملتا ہو، رینج سپورٹ ہو، اور مضبوط ETag ایک جیسا ہو۔ زیادہ سے زیادہ چار مرر۔',
  variant: 'ورژن',
  variants: 'ورژنز',
  'Media stream': 'میڈیا اسٹریم',
  'Media stream · FFmpeg': 'میڈیا اسٹریم · FFmpeg',
  resumable: 'دوبارہ جاری ہو سکتا ہے',
  'size unknown': 'سائز نامعلوم',
  'Uses one connection. The file size is unknown.':
    'ایک کنکشن استعمال ہو رہا ہے۔ فائل کا سائز نامعلوم ہے۔',
  'Uses one connection. This server doesn’t support parallel downloads.':
    'ایک کنکشن استعمال ہو رہا ہے۔ یہ سرور متوازی ڈاؤن لوڈز کی معاونت نہیں کرتا۔',
  'DASH variants are detected, but DASH downloading is not enabled yet. HLS on-demand downloads are supported.':
    'DASH ورژن ملے ہیں، مگر DASH ڈاؤن لوڈ ابھی فعال نہیں۔ HLS آن ڈیمانڈ ڈاؤن لوڈ معاون ہیں۔',
  'Media downloads do not yet enforce bandwidth or data caps. Disable those policies before starting a media download.':
    'میڈیا ڈاؤن لوڈز ابھی بینڈوڈتھ یا ڈیٹا حد نافذ نہیں کرتے۔ میڈیا ڈاؤن لوڈ شروع کرنے سے پہلے یہ پابندیاں بند کریں۔',
  'Media downloads do not enter the queue yet. Wait for an available download slot and an active schedule window.':
    'میڈیا ڈاؤن لوڈ ابھی قطار میں شامل نہیں ہوتے۔ دستیاب ڈاؤن لوڈ جگہ اور فعال شیڈول کا انتظار کریں۔',
  'Loaded {{name}}. Review the list, then preview links.':
    'فائل {{name}} لوڈ ہو گئی۔ فہرست کا جائزہ لیں، پھر لنکس کا پیش نظارہ کریں۔',
  'Could not read file: {{error}}': 'فائل نہیں پڑھی جا سکی: {{error}}',
  'Preview ready: {{ready}} selectable · Failed {{failed}} · Skipped duplicates {{skipped}}':
    'پیش نظارہ تیار: {{ready}} منتخب کیے جا سکتے ہیں · ناکام {{failed}} · دہرائے گئے چھوڑ دیے: {{skipped}}',
  'Added to queue · {{name}} · Package {{package}} · ID {{id}}':
    'قطار میں شامل: {{name}} · پیکیج {{package}} · شناخت {{id}}',
  'Added {{added}} · Failed {{failed}} · Skipped duplicates {{skipped}}':
    'شامل کیے گئے {{added}} · ناکام {{failed}} · دہرائے گئے چھوڑ دیے: {{skipped}}',
  'Retry complete: {{recovered}} recovered · {{failed}} still unresolved':
    'دوبارہ جانچ مکمل: {{recovered}} بحال · {{failed}} اب بھی حل طلب',
  'Imported links': 'درآمد شدہ لنکس',
  downloading: 'ڈاؤن لوڈ ہو رہا ہے',
  queued: 'قطار میں',
  paused: 'موقوف',
  'This link is already {{status}} as {{name}}. You can still start another copy if that is intentional.':
    'یہ لنک پہلے ہی {{status}} ہے: {{name}}۔ اگر جان بوجھ کر نقل درکار ہے تو آپ ایک اور کاپی شروع کر سکتے ہیں۔',
  'Choose a destination folder first.': 'پہلے محفوظ کرنے کا فولڈر منتخب کریں۔',
  'No valid links to preview.': 'پیش نظارہ کے لیے کوئی درست لنک نہیں۔',
  'Select at least one successfully checked link to add to the queue.':
    'قطار میں شامل کرنے کے لیے کم از کم ایک کامیابی سے جانچا گیا لنک منتخب کریں۔',
  Package: 'پیکیج',
  'Unresolved links': 'حل طلب لنکس',
  'Checking the link…': 'لنک چیک ہو رہا ہے…',
  'Same file as {{name}}, which failed. Resume that instead?':
    'وہی فائل {{name}}، جو ناکام ہوئی تھی۔ اسی کو دوبارہ جاری کریں؟',
  'From {{from}}': '{{from}} سے',
  'with your {{service}} sign-in': '{{service}} میں آپ کے سائن اِن کے ساتھ',
  '{{current}} of {{total}}': '{{total}} میں سے {{current}}',
  'This download uses one connection on one network.':
    'یہ ڈاؤن لوڈ ایک نیٹ ورک پر ایک کنکشن استعمال کرتا ہے۔',
  '{{names}} share a subnet ({{subnet}}), so the computer sends both down one route and they can’t be combined.':
    '{{names}} ایک ہی سب نیٹ ({{subnet}}) استعمال کرتے ہیں، اس لیے کمپیوٹر دونوں کو ایک ہی راستے پر بھیجتا ہے اور انہیں یکجا نہیں کیا جا سکتا۔',
  '{{names}} {{verb}} reached {{possessive}} data limit. Choose another network for this download.':
    '{{names}} {{verb}} ڈیٹا حد تک پہنچ گیا ہے۔ اس ڈاؤن لوڈ کے لیے دوسرا نیٹ ورک منتخب کریں۔',
  'Every network has reached its data limit. Raise one in Speed & data limits.':
    'ہر نیٹ ورک اپنی ڈیٹا حد تک پہنچ گیا ہے۔ رفتار اور ڈیٹا حدود میں حد بڑھائیں۔',
  Change: 'تبدیل کریں',
  'No downloads match “{{search}}”': '“{{search}}” سے کوئی ڈاؤن لوڈ مطابقت نہیں رکھتا',
  'Clear search': 'تلاش صاف کریں',
  'No downloads in progress': 'کوئی ڈاؤن لوڈ جاری نہیں',
  'No finished downloads': 'کوئی مکمل ڈاؤن لوڈ نہیں',
  'No downloads need attention': 'کسی ڈاؤن لوڈ پر توجہ درکار نہیں',
  'Show all downloads': 'تمام ڈاؤن لوڈ دکھائیں',
  'Needs attention': 'توجہ درکار',
  'Select all downloads needing attention': 'توجہ درکار تمام ڈاؤن لوڈ منتخب کریں',
  'Select all {{group}} downloads': '{{group}} کے تمام ڈاؤن لوڈ منتخب کریں',
  Inactive: 'غیر فعال',
  'All downloads': 'تمام ڈاؤن لوڈ',
  'Finished downloads': 'مکمل ڈاؤن لوڈ',
  'In progress': 'جاری',
  'Download history': 'ڈاؤن لوڈ کی تاریخ',
  History: 'تاریخ',
  Sort: 'ترتیب',
  'Clear finished list': 'مکمل فہرست صاف کریں',
  'Finished, in-progress, queued and paused downloads': 'مکمل، جاری، قطار میں اور موقوف ڈاؤن لوڈ',
  'No downloads yet': 'ابھی کوئی ڈاؤن لوڈ نہیں',
  'No networks connected': 'کوئی نیٹ ورک منسلک نہیں',
  "Speed-o' -Freq Sonic needs at least one active network. Join a Wi-Fi network, plug in Ethernet, or connect your phone using USB tethering.":
    "Speed-o' -Freq Sonic کو کم از کم ایک فعال نیٹ ورک درکار ہے۔ Wi-Fi سے جڑیں، Ethernet لگائیں، یا USB tethering سے فون منسلک کریں.",
  'Paste a link ({{shortcut}}) or drop a .torrent anywhere in this window.':
    'لنک چسپاں کریں ({{shortcut}}) یا اس ونڈو میں کہیں بھی .torrent فائل ڈالیں۔',
  'Scan again': 'دوبارہ اسکین کریں',
  'Network settings': 'نیٹ ورک ترتیبات',
  'New download': 'نیا ڈاؤن لوڈ',
  Downloading: 'ڈاؤن لوڈ ہو رہا ہے',
  Complete: 'مکمل',
  Completed: 'مکمل',
  Failed: 'ناکام',
  Queued: 'قطار میں',
  Seeding: 'سیڈنگ',
  Active: 'فعال',
  'Only your default network can be used': 'صرف آپ کا طے شدہ نیٹ ورک استعمال ہو سکتا ہے',
  'This system doesn’t let apps send a connection through a specific network, which needs Linux kernel 5.7 or newer. Every connection will go through your default network, so the others will show no ping and won’t add speed. Updating your system fixes this.':
    'یہ نظام ایپس کو کسی مخصوص نیٹ ورک کے ذریعے کنکشن بھیجنے نہیں دیتا؛ اس کے لیے Linux kernel 5.7 یا نیا درکار ہے۔ ہر کنکشن طے شدہ نیٹ ورک سے گزرے گا، اس لیے دوسرے نیٹ ورکس پر پنگ نہیں آئے گی اور رفتار میں اضافہ نہیں ہوگا۔ نظام اپ ڈیٹ کرنے سے یہ مسئلہ حل ہو جاتا ہے۔',
  'Got it': 'سمجھ گیا',
  'Paste a new link': 'نیا لنک چسپاں کریں',
  'New link': 'نیا لنک',
  Checking: 'جانچ جاری ہے',
  'Continue download': 'ڈاؤن لوڈ جاری رکھیں',
  'More actions': 'مزید کارروائیاں',
  'Switch to light theme': 'روشن تھیم پر جائیں',
  'Switch to dark theme': 'تاریک تھیم پر جائیں',
  'Quick traffic profile': 'فوری ٹریفک پروفائل',
  'full traffic profile': 'مکمل رفتار پروفائل',
  'balanced traffic profile': 'متوازن رفتار پروفائل',
  'quiet traffic profile': 'کم رفتار پروفائل',
  'Full speed: no global download speed cap': 'مکمل رفتار: ڈاؤن لوڈ کی عمومی حد نہیں',
  'Balanced: global download cap of 5 MiB/s': 'متوازن: ڈاؤن لوڈ کی عمومی حد 5 MiB/s',
  'Quiet: global download cap of 512 KiB/s': 'خاموش: ڈاؤن لوڈ کی عمومی حد 512 KiB/s',
  'Custom speed limit active; choose a preset to apply it':
    'حسب ضرورت رفتار کی حد فعال ہے؛ لاگو کرنے کے لیے ایک پیش سیٹ منتخب کریں',
  free: 'خالی',
  '{{count}} waiting': 'انتظار میں {{count}}',
  'Slow mode': 'سست موڈ',
  FULL: 'مکمل',
  BALANCED: 'متوازن',
  QUIET: 'خاموش',
  // Keep every directly requested UI label translated, including the less common mirror flow.
  'Mirror site \u2014 dry run': '??? ???? ?? ??? \u2014 ??????? ?????',
  'Starting page URL': '??????? ???? ?? URL',
  'File extensions (comma-separated)': '???? ?? ??????? (???? ?? ??? ????)',
  'Link depth (0\u20133)': '???? ?? ?????? (0 ?? 3)',
  'Page limit (1\u201350)': '????? ?? ?? (1 ?? 50)',
  'Delay (0.5\u20135 sec)': '???? (0.5 ?? 5 ?????)',
  'Previewing\u2026': '??? ????? ???? ??\u2026',
  'Preview site': '??? ???? ?? ??? ?????',
  'Cancel preview': '??? ????? ????? ????',
  'Max 50 pages, 100 candidate files, 1 MB per page.':
    '????? ?? ????? 50 ?????? 100 ????? ??????? ?? ???? 1 MB?',
  'Speed units': '????? ?? ???????'
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, values?: Record<string, string | number>) => string
}
const LocaleContext = createContext<LocaleContextValue | null>(null)
const STORAGE_KEY = 'sonic.locale.v1'

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'ur' ? 'ur' : 'en'
    } catch {
      return 'en'
    }
  })
  const setLocale = (next: Locale): void => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* Private browsing: session state still works. */
    }
  }
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ur' ? 'rtl' : 'ltr'
    document.documentElement.dataset.locale = locale
  }, [locale])
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => {
        const dictionary = messages[locale] as Record<string, string>
        const message =
          dictionary[key] ??
          (locale === 'ur' ? (literalUrdu[key] ?? literalUrduMore[key] ?? key) : key)
        return Object.entries(values ?? {}).reduce(
          (current, [name, value]) => current.split(`{{${name}}}`).join(String(value)),
          message
        )
      }
    }),
    [locale]
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
