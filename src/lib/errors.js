/** خطأ أعمال يُعرض للمستخدم برسالة عربية واضحة */
export class AppError extends Error {
  constructor(message, { status = 400, code = 'bad_request' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const notFound = (what = 'العنصر') => new AppError(`${what} غير موجود`, { status: 404, code: 'not_found' });
export const forbidden = (msg = 'ليست لديك صلاحية لتنفيذ هذا الإجراء') => new AppError(msg, { status: 403, code: 'forbidden' });
