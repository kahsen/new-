import React, { useEffect, useState, useCallback, useRef, memo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Modal, TextInput, FlatList, Pressable, Keyboard,
  StyleSheet, Animated, AppState, ActivityIndicator, Linking, BackHandler, Platform, KeyboardAvoidingView, Share,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

const KEY = 'accounts.v2';
const PAGES_KEY = 'pages.v1'; // last open page per tab // same key as before: older saved Discord accounts load fine
const SLOTS = [['Main', 'discord.com'], ['PTB', 'ptb.discord.com'], ['Canary', 'canary.discord.com']];
// Each Discord web address keeps its own saved login, so slots give up to 3 persistent, separate accounts
// even if the per-tab storage patch is not active.
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const DEFAULT_SETTINGS = { desktop: false, zoom: 1, compact: false, warm: 4, live: 8, temp: false, pin: '', lockAfter: 60, cover: false }; // warm = pre-load on launch, live = max loaded tabs
const ZOOM_MIN = 0.5, ZOOM_MAX = 2;
const ALLOWED = ['discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg', 'discord.media', 'hcaptcha.com'];
const COLORS = ['#5865F2', '#eb459e', '#f0b232', '#23a55a', '#e8590c', '#1c9cd6', '#9b59b6', '#e74c3c'];
const PRESETS = [
  ['Google', 'https://www.google.com'], ['YouTube', 'https://m.youtube.com'], ['Reddit', 'https://www.reddit.com'],
  ['X', 'https://x.com'], ['GitHub', 'https://github.com'], ['Wikipedia', 'https://en.wikipedia.org'],
];

// Sets the Discord page viewport width so the layout fits the phone. Idempotent; safe to re-inject any time.
const vpScript = (desktop, zoom) => `
(function(){
  var w=Math.round(${desktop ? 1100 : 'window.screen.width'}/${zoom});
  window.__vp='width='+w+', user-scalable=yes';
  if(!window.__vpA){
    window.__vpA=function(){
      var m=document.querySelector('meta[name=viewport]');
      if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m);}
      if(m.content!==window.__vp)m.content=window.__vp;
    };
    setInterval(window.__vpA,2500);
  }
  window.__vpA();
})(); true;`;
// Detects when two tabs are secretly sharing one browser storage (i.e. isolated logins are NOT working).
const ownerScript = (id) => `
(function(){try{var k='__rn_tab_owner',me=${JSON.stringify(id)},o=localStorage.getItem(k);
if(!o){localStorage.setItem(k,me);}
else if(o!==me){window.ReactNativeWebView.postMessage(JSON.stringify({t:'shared'}));}}catch(e){}})(); true;`;
// Reports the page title (Discord/sites show unread counts like "(3) Discord") so tabs can show badges.
const titleScript = `
(function(){ if(window.__rnT) return; window.__rnT=1; var last=null;
  function s(){try{var t=document.title||''; if(t!==last){last=t; window.ReactNativeWebView.postMessage(JSON.stringify({t:'title',v:t}));}}catch(e){}}
  setInterval(s,3000); s(); })(); true;`;
const PAUSE_MEDIA = "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(e){}}); true;";

// iOS needs a valid UUID for an isolated WebKit data store (separate cookies/login per tab)
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const colorOf = (id) => COLORS[id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initial = (label) => (Array.from(label.trim())[0] || '?').toUpperCase();
const hostOf = (u) => { const m = /^https?:\/\/(?:www\.)?([^\/:?#]+)/i.exec(u || ''); return m ? m[1] : u || ''; };
const hostOnly = (u) => ((/^https?:\/\/([^\/:?#]+)/i.exec(u || '') || [])[1] || '').toLowerCase();
const hashPin = (c) => { let h = 5381; const x = 'dsw1' + c; for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return String(h >>> 0); };
const pinned = (arr) => [...arr.filter((a) => a.pinned), ...arr.filter((a) => !a.pinned)];
const validColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : undefined);
const normalizeUrl = (raw) => {
  let x = (raw || '').trim();
  if (!x) return null;
  if (!/^https?:\/\//i.test(x)) x = 'https://' + x;
  return /^https?:\/\/([^\s.\/]+(\.[^\s.\/]+)+|localhost)(:\d+)?([\/?#]\S*)?$/i.test(x) ? x : null;
};

function PinPad({ title, subtitle, onComplete, onCancel }) {
  const [code, setCode] = useState('');
  const press = (d) => {
    const n = (code + d).slice(0, 4);
    setCode(n);
    if (n.length === 4) setTimeout(() => { setCode(''); onComplete(n); }, 120);
  };
  return (
    <View style={s.pinWrap}>
      <Text style={s.title}>{title}</Text>
      {!!subtitle && <Text style={s.sub}>{subtitle}</Text>}
      <View style={s.dots}>{[0, 1, 2, 3].map((i) => <View key={i} style={[s.pdot, i < code.length && s.pdotOn]} />)}</View>
      <View style={s.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) => (k === '' ? <View key={i} style={s.key} /> : (
          <TouchableOpacity key={i} style={s.key} onPress={() => (k === '⌫' ? setCode(code.slice(0, -1)) : press(k))}>
            <Text style={s.keyText}>{k}</Text>
          </TouchableOpacity>
        )))}
      </View>
      {onCancel && <TouchableOpacity onPress={onCancel}><Text style={[s.cancel, { marginRight: 0, marginTop: 8 }]}>Cancel</Text></TouchableOpacity>}
    </View>
  );
}

const Avatar = memo(function Avatar({ acc, size = 28 }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: acc.color || colorOf(acc.id),
      alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.46 }}>{initial(acc.label)}</Text>
    </View>
  );
});

const Chip = memo(function Chip({ acc, on, live, badge, onPress, onMenu, chipX }) {
  return (
    <TouchableOpacity
      onPress={() => onPress(acc.id)}
      onLongPress={() => onMenu(acc)} delayLongPress={300}
      onLayout={(e) => { chipX.current[acc.id] = e.nativeEvent.layout.x; }}
      style={[s.chip, on && s.chipOn]}>
      <Avatar acc={acc} size={24} />
      {acc.pinned ? <Text style={s.pinStar}>★</Text> : null}
      <Text style={[s.chipText, on && { color: '#fff' }]} numberOfLines={1}>{acc.label}</Text>
      {live && <View style={s.live} />}
      {badge ? <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View> : null}
      {on && (
        <TouchableOpacity hitSlop={10} onPress={() => onMenu(acc)}>
          <Text style={s.more}>⋯</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
});

// memo + primitive props: switching tabs never re-renders (or reloads) the web views
const AccountView = memo(function AccountView({ acc, active, desktop, zoom, register, setLoading, setError, setCanGoBack, onShared, temp, onProgress, onTitle, restore }) {
  const isSite = acc.kind === 'site';
  const baseUri = isSite ? acc.url : `https://${acc.host || 'discord.com'}/app`;
  const [uri, setUri] = useState(() => {
    if (!restore || hostOnly(restore) !== hostOnly(baseUri)) return baseUri;
    if (!isSite && !/^https:\/\/[^\/]+\/channels\//i.test(restore)) return baseUri;
    return restore; // reopen where you left off
  });
  const firstUri = useRef(true);
  useEffect(() => { if (firstUri.current) { firstUri.current = false; return; } setUri(baseUri); }, [baseUri]);
  const setRef = useCallback((r) => register(acc.id, r), [acc.id, register]);

  // a site that goes to the background stops playing audio/video
  useEffect(() => {
    if (isSite && !active) register(acc.id)?.injectJavaScript(PAUSE_MEDIA);
  }, [active]);

  return (
    <View style={[StyleSheet.absoluteFill, !active && s.hidden]} pointerEvents={active ? 'auto' : 'none'}>
      <WebView
        ref={setRef}
        source={{ uri }}
        incognito={temp}
        applicationNameForUserAgent={temp ? undefined : `RNTAB/${acc.id}`}
        dataStoreIdentifier={temp ? undefined : acc.id}
        userAgent={isSite ? (acc.desktop ? DESKTOP_UA : undefined) : (desktop ? DESKTOP_UA : UA)}
        contentMode={isSite ? (acc.desktop ? 'desktop' : 'recommended') : (desktop ? 'desktop' : 'mobile')}
        injectedJavaScript={ownerScript(acc.id) + titleScript + (isSite ? '' : vpScript(desktop, zoom))}
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.t === 'shared') onShared();
            else if (m.t === 'title') onTitle(acc.id, String(m.v || ''));
          } catch (err) {}
        }}
        onLoadProgress={(e) => onProgress(acc.id, e.nativeEvent.progress)}
        cacheEnabled
        sharedCookiesEnabled={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={isSite}
        allowsBackForwardNavigationGestures
        allowsLinkPreview={false}
        hideKeyboardAccessoryView
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        onFileDownload={(e) => { const u = e?.nativeEvent?.downloadUrl; if (u) Linking.openURL(u).catch(() => {}); }}
        bounces={isSite}
        pullToRefreshEnabled={isSite}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        setSupportMultipleWindows={false}
        onLoadStart={() => { setError(acc.id, false); setLoading(acc.id, true); onProgress(acc.id, 0); }}
        onLoadEnd={() => { setLoading(acc.id, false); onProgress(acc.id, 1); }}
        onError={() => setError(acc.id, true)}
        onNavigationStateChange={(e) => setCanGoBack(acc.id, e.canGoBack, e.url)}
        onContentProcessDidTerminate={() => register(acc.id)?.reload()}
        onRenderProcessGone={() => register(acc.id)?.reload()}
        onShouldStartLoadWithRequest={(req) => {
          if (isSite) {
            // sites navigate freely; mailto:, tel:, app links etc. open outside
            if (/^(https?:|about:|blob:|data:|javascript:)/i.test(req.url)) return true;
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          if (req.isTopFrame === false) return true;
          const m = /^https?:\/\/([^\/:?#]+)/i.exec(req.url);
          if (!m) return true;
          const host = m[1].toLowerCase();
          if (ALLOWED.some((h) => host === h || host.endsWith('.' + h))) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        style={{ backgroundColor: isSite ? '#fff' : '#1e1f22' }}
      />
    </View>
  );
});

function Main() {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);       // every tab: { id, kind: 'discord'|'site', label, url?, desktop? }
  const [activeId, setActiveId] = useState(null);
  const [section, setSection] = useState('discord');
  const [gridSection, setGridSection] = useState('discord');
  const [loaded, setLoaded] = useState(false);
  const [mounted, setMounted] = useState({});
  const [loading, setLoadingState] = useState({});
  const [errors, setErrors] = useState({});
  const [modal, setModal] = useState(null); // add | rename | addSite | editSite | menu | settings | grid
  const [target, setTarget] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [urlErr, setUrlErr] = useState(false);
  const [kb, setKb] = useState(false);
  const [tick, setTick] = useState(0);
  const [sharedWarn, setSharedWarn] = useState(false);
  const [badges, setBadges] = useState({});
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [slot, setSlot] = useState('discord.com');
  const [query, setQuery] = useState('');
  const [locked, setLocked] = useState(false);
  const [cover, setCover] = useState(false);
  const [lockMsg, setLockMsg] = useState('');
  const [pinStage, setPinStage] = useState('new');
  const [pinMsg, setPinMsg] = useState('');
  const pinTmp = useRef('');
  const fails = useRef(0);
  const lockUntil = useRef(0);
  const bgAt = useRef(0);
  const pagesRef = useRef({});
  const progress = useRef(new Animated.Value(1)).current;
  const activeRef = useRef(null);
  const onShared = useCallback(() => setSharedWarn(true), []);
  const refs = useRef({});
  const canBack = useRef({});
  const curUrl = useRef({});
  const skipPreload = useRef({});
  const order = useRef([]);
  const chipX = useRef({});
  const scroller = useRef(null);
  const urlInput = useRef(null);
  const itemsRef = useRef([]);
  itemsRef.current = items;
  const settingsRef = useRef(DEFAULT_SETTINGS);
  settingsRef.current = settings;
  activeRef.current = activeId;

  // keep the last sheet content/target while the sheet slides out
  const shownModal = useRef(null);
  const shownTarget = useRef(null);
  if (modal) shownModal.current = modal;
  if (target) shownTarget.current = target;

  const register = useCallback((id, r) => {
    if (r !== undefined) refs.current[id] = r;
    return refs.current[id];
  }, []);
  const setLoading = useCallback((id, v) => setLoadingState((l) => (!v && !l[id] ? l : { ...l, [id]: v ? Date.now() : false })), []);
  const onProgress = useCallback((id, p) => {
    if (id !== activeRef.current) return;
    if (p === 0) progress.setValue(0.03);
    else Animated.timing(progress, { toValue: p, duration: 140, useNativeDriver: false }).start();
  }, [progress]);
  const onTitle = useCallback((id, title) => {
    let b = null;
    const m = /^\((\d+\+?)\)/.exec(title);
    if (m) b = m[1]; else if (/^[•●]/.test(title)) b = '•';
    setBadges((p) => ((p[id] ?? null) === b ? p : { ...p, [id]: b }));
  }, []);
  const persistPages = useCallback(() => {
    const ids = new Set(itemsRef.current.map((a) => a.id));
    const next = { ...pagesRef.current };
    Object.keys(next).forEach((id) => { if (!ids.has(id)) delete next[id]; });
    Object.entries(curUrl.current).forEach(([id, u]) => {
      if (ids.has(id) && /^https?:\/\//i.test(u) && u.length < 1500) next[id] = u;
    });
    pagesRef.current = next;
    AsyncStorage.setItem(PAGES_KEY, JSON.stringify(next)).catch(() => {});
  }, []);
  const setError = useCallback((id, v) => setErrors((e) => (!!e[id] === v ? e : { ...e, [id]: v })), []);
  const setCanGoBack = useCallback((id, v, u) => { canBack.current[id] = v; if (u) curUrl.current[id] = u; }, []);

  // load saved data
  useEffect(() => {
    (async () => {
      try {
        try { const p = await AsyncStorage.getItem(PAGES_KEY); if (p) pagesRef.current = JSON.parse(p) || {}; } catch (e) {}
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) {
          const d = JSON.parse(raw);
          const list = (Array.isArray(d.accounts) ? d.accounts : [])
            .filter((a) => a && a.id && a.label)
            .map((a) => ({ kind: 'discord', ...a }))
            .filter((a) => a.kind === 'discord' || (a.kind === 'site' && a.url));
          setItems(list);
          if (d.settings) { setSettings({ ...DEFAULT_SETTINGS, ...d.settings }); if (d.settings.pin) setLocked(true); }
          const act = list.find((a) => a.id === d.activeId) ?? list[0] ?? null;
          if (act) {
            order.current = [act.id];
            setActiveId(act.id); setSection(act.kind); setGridSection(act.kind);
            setMounted({ [act.id]: true });
          } else if (d.section) { setSection(d.section); setGridSection(d.section); }
        }
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  // save (debounced)
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => AsyncStorage.setItem(KEY,
      JSON.stringify({ accounts: items, activeId, section, settings })).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [items, activeId, section, settings, loaded]);

  // warm up other Discord accounts one at a time, only once nothing else is loading
  useEffect(() => {
    if (!loaded) return;
    const now = Date.now();
    const busy = Object.keys(mounted).some((id) => loading[id] && now - loading[id] < 20000);
    if (busy) { // re-check later even if a page never reports "finished"
      const w = setTimeout(() => setTick((n) => n + 1), 20500);
      return () => clearTimeout(w);
    }
    if (settings.temp || Object.keys(mounted).length >= settings.warm) return;
    const next = items.find((a) => a.kind === 'discord' && !mounted[a.id] && !skipPreload.current[a.id]);
    if (!next) return;
    const t = setTimeout(() => setMounted((m) => ({ ...m, [next.id]: true })), 2500);
    return () => clearTimeout(t);
  }, [loaded, items, mounted, loading, tick, settings.warm, settings.temp]);

  // privacy cover + PIN lock when leaving the app
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      const cfg = settingsRef.current;
      if (st === 'active') {
        setCover(false);
        if (cfg.pin && bgAt.current && Date.now() - bgAt.current >= cfg.lockAfter * 1000) { setModal(null); setLocked(true); }
        bgAt.current = 0;
      } else {
        if (cfg.pin || cfg.cover) setCover(true);
        if (st === 'background') { bgAt.current = Date.now(); persistPages(); }
      }
    });
    return () => sub.remove();
  }, [persistPages]);
  useEffect(() => { const i = setInterval(persistPages, 20000); return () => clearInterval(i); }, [persistPages]);

  // new active tab: hide the progress bar until it reports loading
  useEffect(() => { progress.setValue(1); }, [activeId, progress]);

  // Android back button -> back inside the active tab
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeId && canBack.current[activeId]) { refs.current[activeId]?.goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [activeId]);

  // no dead gap above the keyboard
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const a = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // keep the active tab in view
  useEffect(() => {
    const x = chipX.current[activeId];
    if (x != null) scroller.current?.scrollTo({ x: Math.max(0, x - 60), animated: true });
  }, [activeId, section, settings.compact]);

  const select = useCallback((id, kind) => {
    const k = kind || itemsRef.current.find((a) => a.id === id)?.kind || 'discord';
    delete skipPreload.current[id];
    order.current = order.current.filter((x) => x !== id).concat(id);
    setSection(k);
    setActiveId(id);
    setMounted((m) => {
      const n = m[id] ? m : { ...m, [id]: true };
      const keys = Object.keys(n);
      const cap = settingsRef.current.temp ? Infinity : Math.max(1, settingsRef.current.live);
      if (keys.length <= cap) return n;
      const out = { ...n };
      let extra = keys.length - cap;
      const oldestFirst = [...keys].sort((a, b) => order.current.indexOf(a) - order.current.indexOf(b));
      for (const key of oldestFirst) {
        if (extra <= 0) break;
        if (key === id) continue;
        delete out[key]; delete refs.current[key]; skipPreload.current[key] = true; extra--;
      }
      return out;
    });
  }, []);

  const openMenu = useCallback((acc) => { setTarget(acc); setModal('menu'); }, []);
  const close = () => {
    setModal(null); setTarget(null); setName(''); setUrl(''); setUrlErr(false);
    setImportText(''); setImportMsg(''); setSlot('discord.com'); setQuery(''); Keyboard.dismiss();
  };
  const openAdd = (kind) => { setName(''); setUrl(''); setUrlErr(false); setSlot('discord.com'); setModal(kind === 'site' ? 'addSite' : 'add'); };
  const scrollEnd = () => setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 200);

  const applySettings = (next) => {
    const prev = settings;
    setSettings(next);
    const reload = prev.desktop !== next.desktop;
    const rezoom = prev.zoom !== next.zoom;
    if (!reload && !rezoom) return;
    // layout/zoom only apply to Discord tabs; sites keep their own responsive layout
    itemsRef.current.forEach((a) => {
      const r = refs.current[a.id];
      if (!r || a.kind !== 'discord') return;
      if (reload) r.reload();
      else r.injectJavaScript(vpScript(next.desktop, next.zoom));
    });
  };
  const setZoom = (z) => {
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    applySettings({ ...settings, zoom });
  };

  const addAccount = () => {
    const acc = { id: uuid(), kind: 'discord', host: slot, label: name.trim() || `Account ${items.filter((a) => a.kind === 'discord').length + 1}` };
    setItems((a) => [...a, acc]);
    select(acc.id, 'discord');
    close(); scrollEnd();
  };

  const submitSite = () => {
    const u = normalizeUrl(url);
    if (!u) { setUrlErr(true); return; }
    const label = name.trim() || hostOf(u);
    const t = shownTarget.current;
    if (shownModal.current === 'editSite' && t) {
      setItems((a) => a.map((x) => (x.id === t.id ? { ...x, label, url: u } : x)));
    } else {
      const acc = { id: uuid(), kind: 'site', label, url: u, desktop: false };
      setItems((a) => [...a, acc]);
      select(acc.id, 'site');
      scrollEnd();
    }
    close();
  };

  const saveRename = () => {
    const label = name.trim();
    const t = shownTarget.current;
    if (label && t) setItems((a) => a.map((x) => (x.id === t.id ? { ...x, label, host: x.kind === 'discord' ? slot : x.host } : x)));
    close();
  };

  const toggleDesktopSite = (acc) => {
    setItems((a) => a.map((x) => (x.id === acc.id ? { ...x, desktop: !x.desktop } : x)));
    setTimeout(() => refs.current[acc.id]?.reload(), 200);
  };

  const moveItem = (id, dir) => {
    setItems((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return list;
      const kind = list[i].kind;
      let j = i + dir;
      while (j >= 0 && j < list.length && list[j].kind !== kind) j += dir;
      if (j < 0 || j >= list.length) return list;
      const n = [...list]; [n[i], n[j]] = [n[j], n[i]]; return n;
    });
  };
  const togglePin = (acc) => setItems((a) => a.map((x) => (x.id === acc.id ? { ...x, pinned: !x.pinned } : x)));
  const tryUnlock = (code) => {
    if (Date.now() < lockUntil.current) { setLockMsg('Too many tries. Wait a moment.'); return; }
    if (hashPin(code) === settingsRef.current.pin) { fails.current = 0; setLockMsg(''); setLocked(false); return; }
    fails.current += 1;
    if (fails.current >= 5) { lockUntil.current = Date.now() + 30000; fails.current = 0; setLockMsg('Too many tries. Wait 30 seconds.'); }
    else setLockMsg('Wrong PIN');
  };
  const setColor = (acc, color) => {
    setItems((a) => a.map((x) => (x.id === acc.id ? { ...x, color } : x)));
    setTarget({ ...acc, color });
  };
  const goStart = (acc) =>
    refs.current[acc.id]?.injectJavaScript(`window.location.href=${JSON.stringify(acc.url)};true;`);
  const useCurrentAsStart = (acc) => {
    const u = curUrl.current[acc.id];
    if (u && /^https?:/i.test(u)) setItems((a) => a.map((x) => (x.id === acc.id ? { ...x, url: u } : x)));
  };
  const shareLink = (acc) => {
    const u = curUrl.current[acc.id] || acc.url;
    Share.share(Platform.OS === 'ios' ? { url: u } : { message: u }).catch(() => {});
  };
  const sleepOthers = () => {
    Object.keys(mounted).forEach((id) => {
      if (id !== activeId) { skipPreload.current[id] = true; delete refs.current[id]; }
    });
    setMounted(activeId && mounted[activeId] ? { [activeId]: true } : {});
  };
  const switchSection = () => {
    const other = section === 'site' ? 'discord' : 'site';
    const cand = [...order.current].reverse().map((id) => items.find((x) => x.id === id)).find((x) => x && x.kind === other)
      || items.find((x) => x.kind === other);
    if (cand) select(cand.id, cand.kind);
    else { setGridSection(other); setModal('grid'); }
  };

  const duplicateSite = (acc) => {
    const base = acc.label.replace(/\s+\d+$/, '');
    const n = items.filter((x) => x.kind === 'site' && hostOf(x.url) === hostOf(acc.url)).length + 1;
    const copy = { ...acc, id: uuid(), label: `${base} ${n}`.slice(0, 24) };
    setItems((l) => { const i = l.findIndex((x) => x.id === acc.id); const c = [...l]; c.splice(i + 1, 0, copy); return c; });
    select(copy.id, 'site');
    scrollEnd();
  };
  const exportTabs = () =>
    Share.share({ message: JSON.stringify({ v: 1, tabs: items.map(({ id, ...rest }) => rest) }) }).catch(() => {});
  const importTabs = () => {
    try {
      const d = JSON.parse(importText.trim());
      const arr = Array.isArray(d) ? d : d.tabs;
      if (!Array.isArray(arr)) throw new Error('bad');
      const add = [];
      arr.slice(0, 200).forEach((x) => {
        if (!x || (x.kind !== 'discord' && x.kind !== 'site')) return;
        const label = String(x.label || '').trim().slice(0, 24);
        if (x.kind === 'site') {
          const u = normalizeUrl(x.url);
          if (u) add.push({ id: uuid(), kind: 'site', label: label || hostOf(u), url: u, desktop: !!x.desktop, color: validColor(x.color) });
        } else add.push({ id: uuid(), kind: 'discord', label: label || 'Account', host: SLOTS.some(([, h]) => h === x.host) ? x.host : 'discord.com', color: validColor(x.color) });
      });
      if (!add.length) { setImportMsg('Nothing to import.'); return; }
      setItems((l) => [...l, ...add]);
      close();
    } catch (e) { setImportMsg('That doesn’t look like a valid tab list.'); }
  };

  const unload = (id) => {
    skipPreload.current[id] = true;
    setMounted((m) => { const n = { ...m }; delete n[id]; return n; });
    delete refs.current[id];
    if (id === activeId) setActiveId(null);
  };

  const remove = (id) => {
    const gone = items.find((x) => x.id === id);
    const rest = items.filter((x) => x.id !== id);
    setItems(rest);
    setMounted((m) => { const n = { ...m }; delete n[id]; return n; });
    delete refs.current[id];
    order.current = order.current.filter((x) => x !== id);
    if (id === activeId) {
      const nxt = rest.find((x) => x.kind === gone?.kind) ?? rest[0] ?? null;
      setActiveId(nxt?.id ?? null);
      if (nxt) { setSection(nxt.kind); setMounted((m) => ({ ...m, [nxt.id]: true })); }
    }
  };

  if (!loaded) return <View style={s.center}><ActivityIndicator color="#5865F2" /></View>;

  const mode = shownModal.current;
  const tgt = shownTarget.current;
  const sectionItems = pinned(items.filter((a) => a.kind === section));
  const gridItems = pinned(items.filter((a) => a.kind === gridSection));
  const q = query.trim().toLowerCase();
  const gridFiltered = q ? gridItems.filter((a) => a.label.toLowerCase().includes(q) || hostOnly(a.url).includes(q)) : gridItems;
  const count = (k) => items.filter((a) => a.kind === k).length;
  const showErr = activeId && errors[activeId] && !loading[activeId];
  const siteForm = mode === 'addSite' || mode === 'editSite';

  return (
    <View style={s.root}>
      <StatusBar style="light" />

      {/* top bar, or a slim grab strip in full-screen mode */}
      {settings.compact ? (
        <Pressable style={{ paddingTop: insets.top, backgroundColor: '#111214' }}
          onPress={() => applySettings({ ...settings, compact: false })} accessibilityLabel="Show tabs">
          <View style={s.grabWrap}><View style={s.grab} /></View>
        </Pressable>
      ) : (
        <View style={[s.bar, { paddingTop: insets.top + 6 }]}>
          <TouchableOpacity style={s.iconBtn} onPress={() => { setGridSection(section); setModal('grid'); }}
            onLongPress={switchSection} delayLongPress={350} accessibilityLabel="Menu">
            <Text style={s.iconText}>{section === 'site' ? '🌐' : '💬'}</Text>
          </TouchableOpacity>
          <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}
            contentContainerStyle={s.chips}>
            {sectionItems.map((acc) => (
              <Chip key={acc.id} acc={acc} on={acc.id === activeId} live={!!mounted[acc.id]} badge={badges[acc.id]}
                onPress={select} onMenu={openMenu} chipX={chipX} />
            ))}
          </ScrollView>
          <TouchableOpacity style={[s.iconBtn, { marginLeft: 4 }]} onPress={() => setModal('settings')}
            accessibilityLabel="View settings">
            <Text style={s.iconText}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.iconBtn, s.addBtn]} onPress={() => openAdd(section)}
            accessibilityLabel="Add">
            <Text style={s.iconText}>＋</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* content */}
      <View style={{ flex: 1, marginBottom: kb ? 0 : insets.bottom }}>
        <Animated.View pointerEvents="none" style={[s.progress, {
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          opacity: progress.interpolate({ inputRange: [0, 0.97, 1], outputRange: [1, 1, 0] }),
        }]} />
        {sectionItems.length === 0 && (
          <View style={s.center}>
            <Text style={s.emoji}>{section === 'site' ? '🌐' : '👋'}</Text>
            <Text style={s.title}>{section === 'site' ? 'Add your first site' : 'Add your first account'}</Text>
            <Text style={s.sub}>
              {section === 'site'
                ? 'Any website, in its own tab.\nEach one keeps its own login.'
                : 'Log in normally.\nEach account stays signed in separately.'}
            </Text>
            <TouchableOpacity style={[s.btn, { marginTop: 18 }]} onPress={() => openAdd(section)}>
              <Text style={s.btnText}>{section === 'site' ? 'Add site' : 'Add account'}</Text>
            </TouchableOpacity>
          </View>
        )}
        {sectionItems.length > 0 && !items.find((a) => a.id === activeId && a.kind === section) && (
          <View style={s.center}><Text style={s.sub}>Pick a tab above</Text></View>
        )}
        {items.map((acc) =>
          mounted[acc.id] ? (
            <AccountView key={`${acc.id}:${settings.temp ? 't' : 'p'}`} acc={acc} active={acc.id === activeId}
              temp={settings.temp} onProgress={onProgress} onTitle={onTitle} restore={pagesRef.current[acc.id]}
              desktop={acc.kind === 'discord' ? settings.desktop : false}
              zoom={acc.kind === 'discord' ? settings.zoom : 1}
              register={register} setLoading={setLoading} setError={setError} setCanGoBack={setCanGoBack} onShared={onShared} />
          ) : null
        )}
        {showErr && (
          <View style={s.errBox}>
            <Text style={s.title}>Couldn’t load the page</Text>
            <Text style={s.sub}>Check your connection and try again.</Text>
            <TouchableOpacity style={[s.btn, { marginTop: 16 }]} onPress={() => refs.current[activeId]?.reload()}>
              <Text style={s.btnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
        {sharedWarn && (
          <View style={s.warn}>
            <Text style={s.warnText}>
              ⚠ Your tabs are sharing ONE login.{' '}
              {Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) < 17
                ? `Separate logins need iOS 17 or newer (this iPhone is on iOS ${Platform.Version}).`
                : 'Separate logins need iOS 17+ and the installed app (not Expo Go).'}
            </Text>
            <TouchableOpacity style={s.warnBtn} onPress={() => { setSettings((p) => ({ ...p, temp: true })); setSharedWarn(false); }}>
              <Text style={s.warnBtnText}>Use temporary logins</Text>
            </TouchableOpacity>
            <TouchableOpacity hitSlop={10} onPress={() => setSharedWarn(false)}><Text style={s.warnX}>✕</Text></TouchableOpacity>
          </View>
        )}
      </View>

      {/* one shared bottom sheet (avoids iOS issues with swapping between several modals) */}
      <Modal visible={!!modal} transparent animationType="slide" onRequestClose={close}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Pressable style={s.sheetBg} onPress={close}>
            <Pressable style={[s.sheet, { paddingBottom: insets.bottom + 12 }, mode === 'grid' && { maxHeight: '75%' }, mode === 'settings' && { maxHeight: '85%' }]}>

              {(mode === 'add' || mode === 'rename') && (
                <>
                  <Text style={s.sheetTitle}>{mode === 'rename' ? 'Rename account' : 'New Discord account'}</Text>
                  <TextInput style={s.input} value={name} onChangeText={setName} autoFocus maxLength={24}
                    placeholder="Label (e.g. Main, Alt)" placeholderTextColor="#777"
                    returnKeyType="done" onSubmitEditing={mode === 'rename' ? saveRename : addAccount} />
                  <Text style={s.label}>Login slot</Text>
                  <View style={s.seg}>
                    {SLOTS.map(([lbl, h]) => (
                      <TouchableOpacity key={h} style={[s.segBtn, slot === h && s.segOn]} onPress={() => setSlot(h)}>
                        <Text style={s.segText}>{lbl}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.hint}>Leave on Main. If two accounts ever show the same login, give them different slots (max 3); each slot keeps its own saved login.</Text>
                  <View style={s.row}>
                    <TouchableOpacity onPress={close}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={s.btn} onPress={mode === 'rename' ? saveRename : addAccount}>
                      <Text style={s.btnText}>{mode === 'rename' ? 'Save' : 'Add'}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {siteForm && (
                <>
                  <Text style={s.sheetTitle}>{mode === 'editSite' ? 'Edit site' : 'New site'}</Text>
                  <TextInput style={s.input} value={name} onChangeText={setName} autoFocus={mode === 'addSite'} maxLength={24}
                    placeholder="Name (optional)" placeholderTextColor="#777"
                    returnKeyType="next" onSubmitEditing={() => urlInput.current?.focus()} />
                  <TextInput ref={urlInput} style={[s.input, { marginTop: 0 }, urlErr && s.inputErr]} value={url}
                    onChangeText={(t) => { setUrl(t); setUrlErr(false); }}
                    placeholder="Address (e.g. reddit.com)" placeholderTextColor="#777"
                    autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done"
                    onSubmitEditing={submitSite} />
                  {urlErr && <Text style={s.errTxt}>That doesn’t look like a valid address.</Text>}
                  {mode === 'addSite' && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
                      style={{ marginBottom: 12 }}>
                      {PRESETS.map(([n, u]) => (
                        <TouchableOpacity key={n} style={s.preset} onPress={() => { setName(n); setUrl(u); setUrlErr(false); }}>
                          <Text style={s.presetText}>{n}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  )}
                  <View style={s.row}>
                    <TouchableOpacity onPress={close}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={s.btn} onPress={submitSite}>
                      <Text style={s.btnText}>{mode === 'editSite' ? 'Save' : 'Add'}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {mode === 'pinSet' && (
                <PinPad key={pinStage} title={pinStage === 'new' ? 'Choose a 4-digit PIN' : 'Confirm your PIN'} subtitle={pinMsg}
                  onCancel={close}
                  onComplete={(c) => {
                    if (pinStage === 'new') { pinTmp.current = c; setPinStage('confirm'); setPinMsg(''); }
                    else if (c === pinTmp.current) { setSettings((p) => ({ ...p, pin: hashPin(c) })); close(); }
                    else { setPinStage('new'); setPinMsg('Codes didn’t match. Try again.'); }
                  }} />
              )}

              {mode === 'import' && (
                <>
                  <Text style={s.sheetTitle}>Import tab list</Text>
                  <TextInput style={[s.input, s.importInput]} value={importText} onChangeText={(v) => { setImportText(v); setImportMsg(''); }}
                    multiline autoFocus autoCapitalize="none" autoCorrect={false}
                    placeholder="Paste a list you exported with “Share tab list”" placeholderTextColor="#777" />
                  {!!importMsg && <Text style={s.errTxt}>{importMsg}</Text>}
                  <Text style={s.hint}>Imports names and addresses only. You log in again in each tab.</Text>
                  <View style={[s.row, { marginTop: 12 }]}>
                    <TouchableOpacity onPress={close}><Text style={s.cancel}>Cancel</Text></TouchableOpacity>
                    <TouchableOpacity style={s.btn} onPress={importTabs}><Text style={s.btnText}>Import</Text></TouchableOpacity>
                  </View>
                </>
              )}

              {mode === 'menu' && tgt && (
                <>
                  <View style={s.sheetHead}>
                    <Avatar acc={tgt} size={34} />
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text style={[s.sheetTitle, { marginLeft: 0, marginBottom: 0 }]} numberOfLines={1}>{tgt.label}</Text>
                      <Text style={s.tileSub} numberOfLines={1}>{tgt.kind === 'site' ? hostOf(tgt.url) : tgt.host || 'discord.com'}</Text>
                    </View>
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
                    style={{ marginVertical: 10 }}>
                    {COLORS.map((c) => (
                      <TouchableOpacity key={c} onPress={() => setColor(tgt, c)}
                        style={[s.swatch, { backgroundColor: c }, (tgt.color || colorOf(tgt.id)) === c && s.swatchOn]} />
                    ))}
                  </ScrollView>
                  <View style={s.moveRow}>
                    <TouchableOpacity style={s.moveBtn} onPress={() => { moveItem(tgt.id, -1); close(); }}>
                      <Text style={s.optText}>◀  Move left</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.moveBtn} onPress={() => { moveItem(tgt.id, 1); close(); }}>
                      <Text style={s.optText}>Move right  ▶</Text>
                    </TouchableOpacity>
                  </View>
                  {tgt.kind === 'site'
                    ? <Opt label="Edit name or address" onPress={() => { setName(tgt.label); setUrl(tgt.url); setModal('editSite'); }} />
                    : <Opt label="Rename / login slot" onPress={() => { setName(tgt.label); setSlot(tgt.host || 'discord.com'); setModal('rename'); }} />}
                  <Opt label={tgt.pinned ? 'Unpin from front' : 'Pin to front'} onPress={() => { togglePin(tgt); close(); }} />
                  <Opt label="Reload" onPress={() => { refs.current[tgt.id]?.reload(); select(tgt.id); close(); }} />
                  {tgt.kind === 'site' && (
                    <>
                      <Opt label={tgt.desktop ? 'Desktop site: on  (tap to turn off)' : 'Desktop site: off  (tap to turn on)'}
                        onPress={() => { toggleDesktopSite(tgt); close(); }} />
                      <Opt label="Add another login for this site" onPress={() => { duplicateSite(tgt); close(); }} />
                      <Opt label="Go to start page" onPress={() => { goStart(tgt); select(tgt.id); close(); }} />
                      <Opt label="Use this page as start page" onPress={() => { useCurrentAsStart(tgt); close(); }} />
                      <Opt label="Share link" onPress={() => { shareLink(tgt); close(); }} />
                      <Opt label="Open in Safari" onPress={() => { Linking.openURL(curUrl.current[tgt.id] || tgt.url).catch(() => {}); close(); }} />
                    </>
                  )}
                  {mounted[tgt.id] && <Opt label={settings.temp ? 'Unload (logs this tab out)' : 'Unload from memory'} onPress={() => { unload(tgt.id); close(); }} />}
                  <Opt label={tgt.kind === 'site' ? 'Remove site' : 'Remove account'} danger
                    onPress={() => { remove(tgt.id); close(); }} />
                </>
              )}

              {mode === 'settings' && (
                <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
                  <Text style={s.sheetTitle}>View settings</Text>
                  <Text style={s.label}>Discord layout</Text>
                  <View style={s.seg}>
                    {[['Mobile', false], ['Desktop', true]].map(([lbl, v]) => (
                      <TouchableOpacity key={lbl} style={[s.segBtn, settings.desktop === v && s.segOn]}
                        onPress={() => settings.desktop !== v && applySettings({ ...settings, desktop: v })}>
                        <Text style={s.segText}>{lbl}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.label}>Tab bar</Text>
                  <View style={s.seg}>
                    {[['Show', false], ['Full screen', true]].map(([lbl, v]) => (
                      <TouchableOpacity key={lbl} style={[s.segBtn, settings.compact === v && s.segOn]}
                        onPress={() => { applySettings({ ...settings, compact: v }); if (v) close(); }}>
                        <Text style={s.segText}>{lbl}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.label}>Discord zoom</Text>
                  <View style={s.zoomRow}>
                    <TouchableOpacity style={s.zoomBtn} onPress={() => setZoom(settings.zoom - 0.1)}><Text style={s.zoomTxt}>−</Text></TouchableOpacity>
                    <Text style={s.zoomVal}>{Math.round(settings.zoom * 100)}%</Text>
                    <TouchableOpacity style={s.zoomBtn} onPress={() => setZoom(settings.zoom + 0.1)}><Text style={s.zoomTxt}>＋</Text></TouchableOpacity>
                    <TouchableOpacity onPress={() => applySettings({ ...settings, zoom: 1 })}>
                      <Text style={[s.cancel, { marginLeft: 22, marginRight: 0 }]}>Reset</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={s.label}>Login storage</Text>
                  <View style={s.seg}>
                    {[['Separate', false], ['Temporary', true]].map(([lbl, v]) => (
                      <TouchableOpacity key={lbl} style={[s.segBtn, settings.temp === v && s.segOn]}
                        onPress={() => settings.temp !== v && setSettings((p) => ({ ...p, temp: v }))}>
                        <Text style={s.segText}>{lbl}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.hint}>Separate keeps every tab signed in on its own (iOS 17+). Temporary always keeps tabs apart on any iOS, but logs you out when the app closes or a tab sleeps.</Text>
                  <Text style={s.label}>Memory</Text>
                  <Stepper label="Pre-load on launch" value={settings.warm} min={0} max={settings.live}
                    onChange={(v) => setSettings((p) => ({ ...p, warm: v }))} />
                  <Stepper label="Max loaded tabs" value={settings.live} min={2} max={16}
                    onChange={(v) => setSettings((p) => ({ ...p, live: v, warm: Math.min(p.warm, v) }))} />
                  <TouchableOpacity style={s.sleepBtn} onPress={() => { sleepOthers(); close(); }}>
                    <Text style={s.optText}>Put all other tabs to sleep</Text>
                  </TouchableOpacity>
                  <Text style={s.label}>Privacy</Text>
                  <View style={s.moveRow}>
                    <TouchableOpacity style={s.moveBtn} onPress={() => { setPinStage('new'); setPinMsg(''); setModal('pinSet'); }}>
                      <Text style={s.optText}>{settings.pin ? 'Change PIN' : 'Set PIN lock'}</Text>
                    </TouchableOpacity>
                    {!!settings.pin && (
                      <TouchableOpacity style={s.moveBtn} onPress={() => setSettings((p) => ({ ...p, pin: '' }))}>
                        <Text style={[s.optText, { color: '#f23f43' }]}>Remove PIN</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {!!settings.pin && (
                    <View style={[s.seg, { marginTop: 8 }]}>
                      {[['Instantly', 0], ['After 1 min', 60], ['After 5 min', 300]].map(([lbl, v]) => (
                        <TouchableOpacity key={lbl} style={[s.segBtn, settings.lockAfter === v && s.segOn]}
                          onPress={() => setSettings((p) => ({ ...p, lockAfter: v }))}>
                          <Text style={[s.segText, { fontSize: 12 }]}>{lbl}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  <View style={[s.seg, { marginTop: 8 }]}>
                    {[['App switcher: visible', false], ['App switcher: hidden', true]].map(([lbl, v]) => (
                      <TouchableOpacity key={lbl} style={[s.segBtn, settings.cover === v && s.segOn]}
                        onPress={() => setSettings((p) => ({ ...p, cover: v }))}>
                        <Text style={[s.segText, { fontSize: 12 }]}>{lbl}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={s.hint}>The PIN is a casual lock for the app screen; it does not encrypt your logins.</Text>
                  <Text style={s.label}>Backup</Text>
                  <View style={s.moveRow}>
                    <TouchableOpacity style={s.moveBtn} onPress={exportTabs}><Text style={s.optText}>Share tab list</Text></TouchableOpacity>
                    <TouchableOpacity style={s.moveBtn} onPress={() => setModal('import')}><Text style={s.optText}>Import list</Text></TouchableOpacity>
                  </View>
                  <Text style={s.hint}>Layout and zoom apply to Discord accounts only. Websites use their own responsive layout (use ⋯ › Desktop site per site). Full screen hides the tab bar; tap the thin strip at the top to bring it back. Long-press the 💬/🌐 button to jump between sections.</Text>
                </ScrollView>
              )}

              {mode === 'grid' && (
                <>
                  <View style={s.seg}>
                    {[['discord', '💬 Discord'], ['site', '🌐 Sites']].map(([k, lbl]) => (
                      <TouchableOpacity key={k} style={[s.segBtn, gridSection === k && s.segOn]}
                        onPress={() => setGridSection(k)}>
                        <Text style={s.segText}>{lbl} ({count(k)})</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {gridItems.length > 5 && (
                    <TextInput style={[s.input, { marginVertical: 10 }]} value={query} onChangeText={setQuery}
                      placeholder="Search tabs" placeholderTextColor="#777" autoCapitalize="none" autoCorrect={false} />
                  )}
                  <FlatList
                    keyboardShouldPersistTaps="handled"
                    style={{ marginTop: 6, flexShrink: 1 }}
                    data={q ? gridFiltered : [...gridItems, { id: '__add' }]}
                    numColumns={3}
                    keyExtractor={(a) => a.id}
                    renderItem={({ item }) => item.id === '__add' ? (
                      <TouchableOpacity style={[s.tile, s.addTile]} onPress={() => openAdd(gridSection)}>
                        <View style={s.addCircle}><Text style={s.iconText}>＋</Text></View>
                        <Text style={s.tileText}>{gridSection === 'site' ? 'Add site' : 'Add'}</Text>
                        <Text style={s.tileSub}> </Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity style={[s.tile, item.id === activeId && s.tileOn]}
                        onPress={() => { select(item.id, item.kind); close(); }}
                        onLongPress={() => openMenu(item)} delayLongPress={300}>
                        <Avatar acc={item} size={46} />
                        <Text style={s.tileText} numberOfLines={1}>{item.label}</Text>
                        <Text style={s.tileSub} numberOfLines={1}>
                          {mounted[item.id] ? '● loaded' : '○ asleep'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </>
              )}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {cover && !locked && <View style={s.cover} />}
      {locked && (
        <View style={s.lock}>
          <PinPad title="Enter PIN" subtitle={lockMsg} onComplete={tryUnlock} />
        </View>
      )}
    </View>
  );
}

const Stepper = ({ label, value, min, max, onChange }) => (
  <View style={s.stepRow}>
    <Text style={s.stepLbl}>{label}</Text>
    <View style={s.stepCtl}>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(Math.max(min, value - 1))}><Text style={s.zoomTxt}>−</Text></TouchableOpacity>
      <Text style={s.stepVal}>{value}</Text>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(Math.min(max, value + 1))}><Text style={s.zoomTxt}>＋</Text></TouchableOpacity>
    </View>
  </View>
);

const Opt = ({ label, onPress, danger }) => (
  <TouchableOpacity style={s.opt} onPress={onPress}>
    <Text style={[s.optText, danger && { color: '#f23f43' }]}>{label}</Text>
  </TouchableOpacity>
);

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1e1f22' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e1f22' },
  bar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111214', paddingBottom: 8, paddingHorizontal: 8 },
  chips: { alignItems: 'center', paddingHorizontal: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#2b2d31', paddingLeft: 6, paddingRight: 12,
    height: 38, borderRadius: 19, marginRight: 8, maxWidth: 190 },
  chipOn: { backgroundColor: '#5865F2' },
  chipText: { color: '#b5bac1', fontWeight: '600', fontSize: 14, marginLeft: 8, flexShrink: 1 },
  live: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#23a55a', marginLeft: 8 },
  more: { color: '#fff', fontSize: 20, fontWeight: '800', marginLeft: 8, marginTop: -4 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#2b2d31', alignItems: 'center', justifyContent: 'center' },
  addBtn: { backgroundColor: '#3a3d44', marginLeft: 4 },
  iconText: { color: '#fff', fontSize: 18 },
  hidden: { opacity: 0, zIndex: -1 },
  spinner: { position: 'absolute', top: 16, alignSelf: 'center' },
  errBox: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e1f22', padding: 24 },
  emoji: { fontSize: 42, marginBottom: 10 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  sub: { color: '#949ba4', textAlign: 'center', lineHeight: 22 },
  input: { backgroundColor: '#1e1f22', color: '#fff', borderRadius: 12, padding: 13, marginVertical: 14, fontSize: 16 },
  inputErr: { borderWidth: 1, borderColor: '#f23f43' },
  errTxt: { color: '#f23f43', fontSize: 12, marginBottom: 10, marginTop: -6 },
  preset: { backgroundColor: '#1e1f22', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, marginRight: 8 },
  presetText: { color: '#dbdee1', fontWeight: '600', fontSize: 13 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  cancel: { color: '#b5bac1', marginRight: 22, fontSize: 16 },
  btn: { backgroundColor: '#5865F2', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  sheetBg: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#2b2d31', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginLeft: 4, marginBottom: 6 },
  opt: { paddingVertical: 15, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#3f4147' },
  optText: { color: '#fff', fontSize: 16 },
  grabWrap: { height: 16, alignItems: 'center', justifyContent: 'center' },
  grab: { width: 44, height: 4, borderRadius: 2, backgroundColor: '#4e5058' },
  label: { color: '#949ba4', fontSize: 12, fontWeight: '700', marginTop: 14, marginBottom: 8, textTransform: 'uppercase' },
  seg: { flexDirection: 'row', backgroundColor: '#1e1f22', borderRadius: 12, padding: 3 },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
  segOn: { backgroundColor: '#5865F2' },
  segText: { color: '#fff', fontWeight: '600' },
  zoomRow: { flexDirection: 'row', alignItems: 'center' },
  zoomBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1e1f22', alignItems: 'center', justifyContent: 'center' },
  zoomTxt: { color: '#fff', fontSize: 22 },
  zoomVal: { color: '#fff', fontSize: 17, fontWeight: '700', width: 70, textAlign: 'center' },
  hint: { color: '#949ba4', fontSize: 12, marginTop: 14, lineHeight: 17 },
  warn: { position: 'absolute', top: 8, left: 8, right: 8, zIndex: 20, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0b232', borderRadius: 12, padding: 12 },
  warnText: { flex: 1, color: '#1e1f22', fontWeight: '600', fontSize: 13, lineHeight: 18 },
  warnX: { color: '#1e1f22', fontSize: 16, fontWeight: '800', marginLeft: 10 },
  progress: { position: 'absolute', top: 0, left: 0, height: 3, backgroundColor: '#5865F2', zIndex: 30 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: '#f23f43', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, marginLeft: 8 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  warnBtn: { backgroundColor: '#1e1f22', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, marginLeft: 8 },
  warnBtnText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  importInput: { minHeight: 110, maxHeight: 200, textAlignVertical: 'top' },
  pinStar: { color: '#f0b232', fontSize: 12, marginLeft: 6 },
  pinWrap: { alignItems: 'center', paddingVertical: 8 },
  dots: { flexDirection: 'row', marginVertical: 18 },
  pdot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#949ba4', marginHorizontal: 8 },
  pdotOn: { backgroundColor: '#fff', borderColor: '#fff' },
  pad: { width: 252, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  key: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1e1f22', alignItems: 'center', justifyContent: 'center', margin: 6 },
  keyText: { color: '#fff', fontSize: 26, fontWeight: '600' },
  lock: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111214', zIndex: 1000, alignItems: 'center', justifyContent: 'center' },
  cover: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111214', zIndex: 999 },
  swatch: { width: 30, height: 30, borderRadius: 15, marginRight: 10 },
  swatchOn: { borderWidth: 3, borderColor: '#fff' },
  moveRow: { flexDirection: 'row', marginBottom: 6 },
  moveBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, backgroundColor: '#1e1f22', borderRadius: 12, marginHorizontal: 3 },
  stepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  stepLbl: { color: '#dbdee1', fontSize: 15 },
  stepCtl: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1e1f22', alignItems: 'center', justifyContent: 'center' },
  stepVal: { color: '#fff', width: 40, textAlign: 'center', fontWeight: '700' },
  sleepBtn: { marginTop: 6, paddingVertical: 12, alignItems: 'center', backgroundColor: '#1e1f22', borderRadius: 12 },
  tile: { flex: 1 / 3, alignItems: 'center', padding: 12, margin: 4, borderRadius: 14, backgroundColor: '#1e1f22' },
  tileOn: { borderWidth: 2, borderColor: '#5865F2' },
  addTile: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#4e5058', backgroundColor: 'transparent' },
  addCircle: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#3a3d44', alignItems: 'center', justifyContent: 'center' },
  tileText: { color: '#fff', marginTop: 8, fontWeight: '600', fontSize: 13 },
  tileSub: { color: '#949ba4', fontSize: 11, marginTop: 2 },
});
