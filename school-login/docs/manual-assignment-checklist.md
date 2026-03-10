# Manual sanity checklist: teaching assignments

- [ ] Teacher without assignment cannot open `/teacher/grades/:classId` (expect HTTP 403 error page).
- [ ] Assign two teachers to the same class+subject in `/admin/assignments/new`; both can open grade routes and create/edit/delete grades.
- [ ] Admin can review grouped assignments in `/admin/assignments` and remove single teacher links from there.
- [ ] Duplicate assignment attempt shows a friendly message and does not create duplicate rows in `class_subject_teacher`.
- [ ] Teacher class list (`/teacher/classes`) only shows class/subject assignments linked through `class_subject_teacher`.
