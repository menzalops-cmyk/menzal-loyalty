// تحسينات تدريجية بسيطة — كل الصفحات تعمل بدون JavaScript
document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const el = document.querySelector(copy.dataset.copy);
    navigator.clipboard?.writeText(el.value || el.textContent).then(() => {
      const t = copy.textContent; copy.textContent = 'تم النسخ ✓'; setTimeout(() => (copy.textContent = t), 1600);
    });
  }
  const share = e.target.closest('[data-share]');
  if (share && navigator.share) {
    e.preventDefault();
    navigator.share({ title: 'منزال', text: share.dataset.text, url: share.dataset.share }).catch(() => {});
  }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) document.querySelector(toggle.dataset.toggle)?.classList.toggle('open');
  const confirmBtn = e.target.closest('[data-confirm]');
  if (confirmBtn && !window.confirm(confirmBtn.dataset.confirm)) e.preventDefault();
});
// تحديث عرض السعر تلقائيًا عند تغيير التواريخ أو المكافأة
document.querySelectorAll('form[data-autosubmit]').forEach((f) => {
  f.addEventListener('change', (e) => { if (e.target.matches('input[type=date], select, input[type=radio]')) f.requestSubmit(); });
});
// إظهار خيار واتساب التسويقي فقط عند الموافقة على واتساب
const wa = document.querySelector('#consent_whatsapp');
const wam = document.querySelector('#wa_marketing_row');
if (wa && wam) { const sync = () => wam.classList.toggle('hidden', !wa.checked); wa.addEventListener('change', sync); sync(); }
