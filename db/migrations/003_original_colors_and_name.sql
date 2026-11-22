-- إرجاع ألوان المستويات الأصلية (أخضر + ذهبي) واعتماد اسم «ضيوف مِنزال»
UPDATE tiers SET color = '#0f4c4f' WHERE color = '#640211';
UPDATE tiers SET color = '#c8963e' WHERE color = '#b77b09';
UPDATE tiers SET color = '#7b8a8b' WHERE color = '#8a8f94';
UPDATE loyalty_programs SET name = 'ضيوف مِنزال' WHERE name = 'نادي ضيوف منزال';
UPDATE message_templates SET subject = 'أهلًا بك في ضيوف مِنزال 🤍' WHERE key = 'welcome' AND subject = 'أهلًا بك في نادي ضيوف منزال';
