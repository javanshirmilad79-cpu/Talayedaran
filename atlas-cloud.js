/* Atlas Cloud Bridge v3 — browser-only frontend, server-authorized writes. */
(function () {
  'use strict';
  const cfg = window.ATLAS_CONFIG || {};
  const url = String(cfg.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(cfg.supabasePublishableKey || '').trim();
  function isSecretKey(candidate) {
    if (/sb_secret_/i.test(candidate)) return true;
    if (candidate.split('.').length === 3) {
      try {
        const payload = JSON.parse(atob(candidate.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        return ['service_role','supabase_admin'].includes(payload.role);
      } catch (_) { return true; }
    }
    return false;
  }
  const enabled = /^https:\/\/[\w.-]+\.supabase\.co$/.test(url) &&
    key.length > 20 && !isSecretKey(key);
  let client = null;
  let userProfile = null;
  let loading = false;
  let dataReady = false;
  let requireApproval = false;
  const unsaved = new Map();
  let revision = Object.create(null);
  let channel = null;
  const work = new Map();
  let refreshTimer = null;
  let lastReload = 0;
  let hasPublishedRows = false;
  const embeddedNode = document.getElementById('atlasPublishedContent');
  let embeddedPages = {};
  try { embeddedPages = JSON.parse(embeddedNode?.textContent || '{}').pages || {}; } catch (_) {}

  const alertBox = () => document.getElementById('atlasCloudStatus');
  function updateRetryButton() {
    const btn = document.getElementById('atlasCloudRetry');
    if (!btn) return;
    const pending = unsaved.get(Number(window.currentPage) || 1);
    btn.hidden = !pending?.failed;
  }
  function status(message, kind='info') {
    const elem = alertBox();
    if (elem) {
      const messageNode = document.getElementById('atlasCloudMessage') || elem;
      messageNode.textContent = message;
      updateRetryButton();
      elem.style.borderColor = kind === 'error' ? '#ef4444' : kind === 'success' ? '#10b981' : '#64748b';
      elem.style.color = kind === 'error' ? '#fecaca' : kind === 'success' ? '#bbf7d0' : '#e2e8f0';
    }
  }
  function panel() {
    if (alertBox()) return;
    const node = document.createElement('div');
    node.id = 'atlasCloudStatus'; node.dir = 'rtl'; node.setAttribute('role', 'status');
    node.style.cssText = 'width:100%;max-width:1140px;padding:11px 16px;margin:0 auto 14px;border:1px solid #64748b;border-radius:12px;background:#0f172a;font:600 13px/1.9 system-ui;color:#e2e8f0';
    document.querySelector('.top-action-bar')?.after(node);
    const messageNode = document.createElement('div');
    messageNode.id='atlasCloudMessage'; node.appendChild(messageNode);
    const retry = document.createElement('button');
    retry.id = 'atlasCloudRetry'; retry.type = 'button'; retry.hidden = true;
    retry.textContent = 'تلاش مجدد برای ذخیره صفحه';
    retry.style.cssText='margin-top:7px;padding:6px 10px;border:1px solid #fca5a5;border-radius:8px;background:#7f1d1d;color:white;cursor:pointer';
    retry.addEventListener('click',()=>retryPage(Number(window.currentPage)||1).catch(error=>status(error.message,'error')));
    node.appendChild(retry);
  }
  function check(result) {
    if (result.error) throw new Error(result.error.message || 'خطای ارتباط با پایگاه داده');
    return result.data;
  }
  function cleanIncoming(data) {
    return window.atlasPagesStore.cleanPage(data || {});
  }
  async function profileForCurrentAuth() {
    const { data: auth, error } = await client.auth.getUser();
    if (error || !auth?.user) { userProfile = null; return; }
    const p = check(await client.from('atlas_profiles')
      .select('user_id,email,display_name,assigned_page,role,unit_name,requested_page')
      .eq('user_id', auth.user.id).maybeSingle());
    userProfile = p ? {
      userId: p.user_id, email: p.email || auth.user.email,
      displayName: p.display_name || auth.user.email, role: p.role || 'user',
      assignedPage: p.assigned_page, requestedPage: p.requested_page,
      unitName: p.unit_name || ''
    } : null;
  }
  async function reload(options={}) {
    if (!enabled || !client) return;
    if (loading) return;
    loading = true;
    try {
      await profileForCurrentAuth();
      const published = check(await client.from('atlas_pages').select('page_number,data,revision')) || [];
      const settings = check(await client.from('atlas_settings').select('require_approval').eq('id',true).single());
      requireApproval = !!settings?.require_approval;
      const nextPages = {}; // Connected mode uses ONLY authoritative server data.
      hasPublishedRows = published.length > 0;
      const nextRevisions = Object.create(null);
      for (const row of published) {
        if (row.page_number >= 1 && row.page_number <= 95) {
          nextPages[row.page_number] = cleanIncoming(row.data);
          nextRevisions[row.page_number] = Number(row.revision) || 0;
        }
      }
      let pending = [];
      if (userProfile) {
        pending = check(await client.from('atlas_edits')
          .select('id,page_number,data,status,submitted_at,submitted_by_name,submitted_by_email,user_id')
          .eq('status','pending')) || [];
      }
      const nextPending = {};
      for (const item of pending) {
        if (item.page_number < 1 || item.page_number > 95) continue;
        nextPending[item.page_number] = {
          ...cleanIncoming(item.data), submissionId: item.id,
          submittedByEmail: item.submitted_by_email || '',
          submittedByName: item.submitted_by_name || '',
          submittedAt: new Date(item.submitted_at).getTime(), status:'pending'
        };
      }
      // Never overwrite the DOM while the current editor is being used.
      window.pagesData = nextPages; window.pendingEdits = nextPending;
      revision = nextRevisions;
      lastReload = Date.now();
      dataReady = true;
      if (options.render !== false && typeof window.renderPage === 'function') {
        const current = Number(window.currentPage) || 1;
        if (work.has(current) || unsaved.has(current) || (typeof window.canEditCurrentPage === 'function' &&
            window.canEditCurrentPage() && document.activeElement?.closest?.('[contenteditable="true"]'))) {
          // A remote change to the same page will be rejected on save via revision check.
          if (typeof window.checkAuthStatus === 'function') window.checkAuthStatus();
        } else window.renderPage(current);
      }
      if (typeof window.renderApprovalsList === 'function') window.renderApprovalsList();
      updateRetryButton();
    } catch (error) { status('دریافت داده از سرور ناموفق بود: ' + error.message, 'error'); throw error; }
    finally { loading = false; }
  }
  function scheduleReload() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => reload().catch(console.error), 130);
  }
  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('atlas-published-and-approvals')
      .on('postgres_changes',{event:'*',schema:'public',table:'atlas_pages'},scheduleReload)
      .on('postgres_changes',{event:'*',schema:'public',table:'atlas_edits'},scheduleReload)
      .subscribe(s => { if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') status('ارتباط زنده قطع شد؛ بازیابی دوره‌ای فعال است.', 'error'); });
  }
  async function init() {
    panel();
    if (!enabled) {
      status('نسخهٔ اصلاحی هنوز به دیتابیس متصل نشده است. نمایش اطلاعات فقط خواندنی است؛ برای ثبت واقعی، atlas-config.js را تنظیم کنید.', 'error');
      return;
    }
    if (!window.supabase?.createClient) {
      status('کتابخانه Supabase بارگذاری نشد. اتصال اینترنت/CDN را بررسی کنید.', 'error');
      return;
    }
    client = window.supabase.createClient(url,key,{
      auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}
    });
    status('در حال دریافت اطلاعات از دیتابیس مرکزی…');
    await profileForCurrentAuth();
    await reload({render:false});
    subscribe();
    client.auth.onAuthStateChange((_event,_session)=>{
      // Avoid awaiting Supabase API calls inside this callback (the auth lock may deadlock).
      setTimeout(async()=>{
        try { await profileForCurrentAuth(); await reload(); if (typeof window.checkAuthStatus==='function') window.checkAuthStatus(); }
        catch(e) { status('بازیابی نشست ناموفق بود: '+e.message,'error'); }
      },0);
    });
    // Re-sync after reconnect/return from background; polling is fallback, not the real-time channel.
    window.addEventListener('focus',()=>reload().catch(console.error));
    document.addEventListener('visibilitychange',()=>{
      if (document.visibilityState==='visible') reload().catch(console.error);
    });
    setInterval(()=>{
      if (document.visibilityState !== 'hidden' && Date.now()-lastReload > 18000) reload().catch(()=>{});
    },20000);
    status(hasPublishedRows ?
      'اتصال برقرار است؛ داده‌ها از سرور خوانده می‌شوند و به‌روزرسانی زنده دارند.' :
      'به دیتابیس وصل هستید، ولی هنوز هیچ صفحه‌ای وارد نشده است. فایل seed-original-pages.sql را در SQL Editor اجرا کنید.',
      hasPublishedRows ? 'success' : 'error');
  }
  function openSignup() {
    if (!client) { status('ابتدا اتصال پایگاه داده را تنظیم کنید.','error'); return; }
    if (document.getElementById('atlasCloudSignup')) return;
    const overlay=document.createElement('div'); overlay.id='atlasCloudSignup';
    overlay.dir='rtl';
    overlay.style.cssText='position:fixed;inset:0;z-index:100010;display:flex;justify-content:center;align-items:center;padding:15px;background:#000b;overflow-y:auto';
    overlay.innerHTML=`
      <form id="atlasCloudSignupForm" style="width:100%;max-width:490px;padding:25px;border:1px solid #475569;border-radius:20px;background:#111827;color:#f8fafc;box-shadow:0 20px 70px #0009;font:14px/2 system-ui">
        <h2 style="font-size:1.2rem;margin-bottom:14px">ثبت‌نام آنلاین و امن</h2>
        <p style="font-size:12px;color:#cbd5e1;margin-bottom:12px">ایمیل باید تأیید شود. مدیر پس از بررسی، صفحه مجاز برای ویرایش را تعیین می‌کند. تصویر صنعتی و تأیید ماشینی نسخه قدیمی در این مسیر به عنوان مدرک هویتی استفاده نمی‌شود.</p>
        <label style="display:block">نام کامل <input name="fullName" required maxlength="200" autocomplete="name" style="width:100%;padding:10px;color:#111827;border-radius:8px"/></label>
        <label style="display:block">نام واحد صنعتی <input name="unitName" maxlength="250" style="width:100%;padding:10px;color:#111827;border-radius:8px"/></label>
        <label style="display:block">ایمیل <input name="email" type="email" required autocomplete="email" dir="ltr" style="width:100%;padding:10px;color:#111827;border-radius:8px"/></label>
        <label style="display:block">رمز عبور (حداقل ۱۰ کاراکتر) <input name="password" type="password" minlength="10" required autocomplete="new-password" dir="ltr" style="width:100%;padding:10px;color:#111827;border-radius:8px"/></label>
        <label style="display:block">درخواست دسترسی به صفحه <input name="assignedPage" type="number" min="1" max="95" required style="width:100%;padding:10px;color:#111827;border-radius:8px" value="${Number(window.currentPage)||1}"/></label>
        <p id="atlasSignupError" style="color:#fecaca;font-size:12px;margin:9px 0"></p>
        <div style="display:flex;gap:10px;margin-top:15px">
          <button type="submit" style="flex:1;padding:10px;color:white;background:#059669;border:0;border-radius:10px;cursor:pointer">ثبت‌نام</button>
          <button type="button" id="atlasCloseSignup" style="padding:10px;color:white;background:#475569;border:0;border-radius:10px;cursor:pointer">انصراف</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);
    const form=overlay.querySelector('form');
    overlay.querySelector('#atlasCloseSignup').onclick=()=>overlay.remove();
    form.onsubmit=async(event)=>{
      event.preventDefault();
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;
      const data=new FormData(form);
      try {
        const user=await signUp({fullName:String(data.get('fullName')||'').trim(),
          unitName:String(data.get('unitName')||'').trim(),email:String(data.get('email')||'').trim().toLowerCase(),
          password:String(data.get('password')||''),assignedPage:Number(data.get('assignedPage'))});
        if (!user) throw new Error('ثبت‌نام ناموفق بود.');
        alert(user.needsEmailConfirmation ? 'ثبت‌نام ارسال شد. ایمیل خود را تأیید کنید؛ مدیر سپس صفحه شما را تخصیص می‌دهد.' : 'ثبت‌نام انجام شد. برای فعال‌شدن ویرایش، تخصیص صفحه توسط مدیر لازم است.');
        overlay.remove();
        if (typeof window.checkAuthStatus==='function') window.checkAuthStatus();
      } catch(e) {form.querySelector('#atlasSignupError').textContent=e.message;}
      finally {submit.disabled=false;}
    };
  }
  async function signIn(email,password) {
    if (!client) throw new Error('اتصال سرور فعال نیست.');
    check(await client.auth.signInWithPassword({email,password}));
    await profileForCurrentAuth();
    if (!userProfile) throw new Error('پروفایل کاربر در پایگاه داده ایجاد نشده است.');
    await reload();
    status('ورود امن انجام شد.','success');
    return userProfile;
  }
  async function signUp(fields) {
    if (!client) throw new Error('اتصال سرور فعال نیست.');
    const {data,error} = await client.auth.signUp({email:fields.email,password:fields.password,
      options:{emailRedirectTo:window.location.origin+window.location.pathname,
        data:{display_name:fields.fullName,unit_name:fields.unitName || '',requested_page:fields.assignedPage || null}}});
    if (error) throw error;
    if (!data?.user) throw new Error('سرور ثبت‌نام را تأیید نکرد.');
    if (data.session) await profileForCurrentAuth();
    status(data.session ? 'حساب ساخته شد؛ تخصیص صفحه توسط مدیر ضروری است.' :
      'درخواست ثبت‌نام ارسال شد؛ ایمیل خود را تأیید کنید. دسترسی ویرایش پس از تخصیص صفحه توسط مدیر فعال می‌شود.','success');
    return {needsEmailConfirmation:!data.session, email:fields.email};
  }
  async function signOut() {
    if (!client) return;
    if (work.size || unsaved.size) throw new Error('تغییر ذخیره‌نشده وجود دارد؛ ابتدا نتیجه ذخیره را بررسی کنید.');
    check(await client.auth.signOut()); userProfile = null;
    await reload(); status('از حساب خارج شدید.','success');
  }
  async function updateAccount(params) {
    if (!client || !userProfile) throw new Error('ابتدا وارد حساب شوید.');
    if (!params.currentPassword) throw new Error('رمز فعلی الزامی است.');
    if (!params.newEmail && !params.newPassword) throw new Error('تغییر جدیدی وارد نشده است.');
    if (params.newPassword && params.newPassword !== params.confirmPassword) throw new Error('تکرار رمز یکسان نیست.');
    if (params.newPassword && !/^(?=.{10,40}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d])/.test(params.newPassword))
      throw new Error('رمز جدید باید ۱۰ تا ۴۰ کاراکتر شامل حرف بزرگ، کوچک، عدد و علامت باشد.');
    check(await client.auth.signInWithPassword({email:userProfile.email,password:params.currentPassword}));
    const changes={};
    if (params.newEmail && params.newEmail.toLowerCase() !== userProfile.email.toLowerCase()) changes.email=params.newEmail.toLowerCase();
    if (params.newPassword) changes.password=params.newPassword;
    if (!Object.keys(changes).length) throw new Error('تغییر جدیدی وارد نشده است.');
    check(await client.auth.updateUser(changes));
    await profileForCurrentAuth();
    status('درخواست تغییر حساب پذیرفته شد. تغییر ایمیل ممکن است نیاز به تأیید ایمیل داشته باشد.','success');
  }
  function savePage(page,data) {
    if (!client) return Promise.reject(new Error('سرور در دسترس نیست.'));
    const p = Number(page);
    if (!userProfile || (userProfile.role !== 'admin' && userProfile.assignedPage !== p))
      return Promise.reject(new Error('مجوز ویرایش این صفحه را ندارید.'));
    // Debounce typing and coalesce calls for the same page, without losing the last value.
    let item=work.get(p);
    if (!item) { item={latest:null,active:false,timer:0,waiters:[]};work.set(p,item); }
    item.latest = JSON.parse(JSON.stringify(data));
    unsaved.set(p,{payload:item.latest,failed:false});
    updateRetryButton();
    clearTimeout(item.timer);
    status('در حال ثبت تغییرات روی سرور…');
    const promise = new Promise((resolve,reject)=>item.waiters.push({resolve,reject}));
    item.timer=setTimeout(()=>flushPage(p),450);
    return promise;
  }
  async function flushPage(page) {
    const item=work.get(page);
    if (!item || item.active) return;
    item.active=true;
    let lastError=null;
    try {
      while (item.latest) {
        const payload=item.latest; item.latest=null;
        const waiters=item.waiters.splice(0);
        try {
          const answer=check(await client.rpc('atlas_save_page',{
            p_page:page, p_data:payload, p_revision:revision[page] || 0
          }));
          if (answer.status==='published') {
            window.pagesData[page]=payload; delete window.pendingEdits[page];
            revision[page]=Number(answer.revision)||0;
            status('اطلاعات در دیتابیس مرکزی ذخیره و منتشر شد.','success');
          } else {
            window.pendingEdits[page]={...payload,status:'pending',submittedAt:Date.now(),
              submittedByEmail:userProfile.email,submittedByName:userProfile.displayName};
            status('اطلاعات روی سرور ثبت شد و منتظر تأیید مدیر است.','success');
          }
          if (unsaved.has(page) && JSON.stringify(unsaved.get(page).payload)===JSON.stringify(payload)) {
            unsaved.delete(page);
          }
          updateRetryButton();
          if (typeof window.refreshApprovalBanner==='function') window.refreshApprovalBanner();
          for (const w of waiters) w.resolve(answer);
        } catch(e) {
          lastError=e;
          const dirty = unsaved.get(page); if (dirty) dirty.failed=true;
          item.latest=null;
          for (const w of waiters) w.reject(e);
          for (const w of item.waiters.splice(0)) w.reject(e);
          status('ذخیره آنلاین انجام نشد: '+e.message+' — از دکمهٔ تلاش مجدد استفاده کنید یا متن را کپی کنید.','error');
          break;
        }
      }
    } finally {
      item.active=false;
      if (item.latest) item.timer=setTimeout(()=>flushPage(page),150);
      else work.delete(page);
      if(!lastError && !item.latest) scheduleReload();
    }
  }
  function hasFailedFor(page) { return !!unsaved.get(Number(page))?.failed; }
  async function retryPage(page) {
    const draft=unsaved.get(Number(page));
    if (!draft) throw new Error('تغییر ذخیره‌نشده‌ای برای این صفحه وجود ندارد.');
    if (!userProfile) throw new Error('ابتدا وارد حساب شوید.');
    return savePage(page,draft.payload);
  }
  async function review(page,approve) {
    if (!client || userProfile?.role!=='admin') throw new Error('این عملیات فقط برای مدیر اصلی مجاز است.');
    const answer=check(await client.rpc('atlas_review_page',{p_page:Number(page),p_approve:!!approve}));
    await reload(); return answer;
  }
  async function withdraw(page) {
    if (!client || !userProfile) throw new Error('وارد حساب نشده‌اید.');
    const answer=check(await client.rpc('atlas_withdraw_edit',{p_page:Number(page)}));
    await reload(); return answer;
  }
  const api = {
    enabled, get profile(){return userProfile;}, get connected(){return !!client && dataReady;},
    get requireApproval(){return requireApproval;}, hasFailedFor, retryPage,
    get busy(){return work.size>0;}, get revisions(){return revision;},
    init, reload, openSignup, signIn, signUp, signOut, updateAccount, savePage, review, withdraw,
    message:status
  };
  window.atlasCloud=api;
  window.addEventListener('beforeunload',event=>{
    if (!work.size && !unsaved.size) return;
    event.preventDefault(); event.returnValue='';
  });
})();
