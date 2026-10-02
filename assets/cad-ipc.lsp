;;; DSH CAD resident dispatcher.
;;;
;;; APPLOAD this file once per AutoCAD session. A timer polls
;;; %LOCALAPPDATA%\dsh-cad\ipc\inbox.lsp and writes res-<id>.lsp.
;;; It does not call SetForegroundWindow. Commands that must run on the
;;; command processor (HATCH, arbitrary commands) are queued with
;;; vla-SendCommand and answered by dsh:run-pending.
;;;
;;; The file is ASCII S-expressions. Non-ASCII text is \U+XXXX so a GBK
;;; mis-read of the inbox cannot corrupt a request.

(defun dsh:has-fn (name)
  (and name (member (strcase name) (atoms-family 1))))

(defun dsh:try-reactor (ctor events / err sym)
  ;; Never call a missing reactor constructor. On this AutoCAD, vl-catch-all-apply
  ;; does not contain "bad function" for VLR-TIMER-REACTOR and aborts LOAD.
  (if (not (dsh:has-fn ctor))
    nil
    (progn
      (setq sym (read ctor))
      (setq err (vl-catch-all-apply sym (list nil events)))
      (if (vl-catch-all-error-p err) nil err))))

(defun dsh:arm-activity ()
  (setq dsh:cmd-reactor
    (dsh:try-reactor "VLR-COMMAND-REACTOR"
      '((:vlr-commandEnded . dsh:on-activity)
        (:vlr-commandCancelled . dsh:on-activity)
        (:vlr-commandFailed . dsh:on-activity))))
  (setq dsh:lisp-reactor
    (dsh:try-reactor "VLR-LISP-REACTOR"
      '((:vlr-lispEnded . dsh:on-activity)
        (:vlr-lispCancelled . dsh:on-activity))))
  (or dsh:cmd-reactor dsh:lisp-reactor))

(defun dsh:on-activity (reactor args)
  (if dsh:in-activity
    nil
    (progn
      (setq dsh:in-activity T)
      (dsh:tick)
      (setq dsh:in-activity nil)))
  (princ))

(defun dsh:write-ready (poller / f)
  (setq f (open (dsh:path "ready.lsp") "w"))
  (if f
    (progn
      (dsh:emit f (list
        (list "version" "1")
        (list "activeX" (if dsh:activex 1 0))
        (list "document" (getvar "DWGNAME"))
        (list "poller" poller)))
      (princ "\n" f)
      (close f))))

(defun dsh:start (/ err armed)
  (setq dsh:has-vl (dsh:has-fn "VL-LOAD-COM"))
  (setq dsh:activex nil)
  (if dsh:has-vl
    (progn
      (vl-load-com)
      (setq err (vl-catch-all-apply 'vlax-get-acad-object nil))
      (setq dsh:activex (not (vl-catch-all-error-p err)))))
  (if (null dsh:ipc-dir)
    (setq dsh:ipc-dir (strcat (getenv "LOCALAPPDATA") "\\dsh-cad\\ipc\\")))
  (dsh:ensure-dir)
  (setq armed (dsh:arm-activity))
  (setq dsh:running T)
  (dsh:write-ready (if armed "activity" "none"))
  (princ "\nDSH CAD: File IPC loaded. Wake with (dsh:tick-now).")
  (princ))

(defun c:DSHCAD ()
  (if (and (dsh:has-fn "VLR-REMOVE") dsh:cmd-reactor) (vlr-remove dsh:cmd-reactor))
  (if (and (dsh:has-fn "VLR-REMOVE") dsh:lisp-reactor) (vlr-remove dsh:lisp-reactor))
  (setq dsh:running nil dsh:cmd-reactor nil dsh:lisp-reactor nil)
  (dsh:start)
  (princ))

(defun dsh:tick-now ()
  (dsh:tick)
  (princ))

(defun dsh:tick (/ inbox err)
  (dsh:maybe-heartbeat)
  (if dsh:busy
    (dsh:clear-stale-busy)
    (progn
      (setq inbox (dsh:next-request))
      (if inbox
        (progn
          (setq err (vl-catch-all-apply 'dsh:handle-request (list inbox)))
          (if (vl-catch-all-error-p err)
            (dsh:fail
              (dsh:request-id inbox)
              "BACKEND_ERROR"
              (vl-catch-all-error-message err))))))))

(defun dsh:handle-request (inbox / form id)
  (setq form (dsh:read-file inbox))
  (dsh:delete-file inbox)
  (setq id (dsh:get form "id"))
  (if (null id) (setq id (dsh:request-id inbox)))
  (if (and id (findfile (dsh:path (strcat "cancel-" id ".lsp"))))
    (progn
      (dsh:delete-file (dsh:path (strcat "cancel-" id ".lsp")))
      (dsh:fail id "TIMEOUT" "request cancelled"))
    (if form
      (dsh:dispatch id form)
      (dsh:fail id "BACKEND_ERROR" "无法读取请求"))))

(defun dsh:clear-stale-busy (/ now)
  (setq now (dsh:now))
  (if (and dsh:busy-since (> now 0) (> (- now dsh:busy-since) 60000))
    (setq dsh:busy nil dsh:pending nil)))

(defun dsh:maybe-heartbeat (/ now)
  (setq now (dsh:now))
  (if (or (null dsh:hb-at) (= now 0) (> (- now dsh:hb-at) 500))
    (progn
      (dsh:write-heartbeat)
      (setq dsh:hb-at now))))

(defun dsh:write-heartbeat (/ f)
  ;; In place, so a poll never sees the file disappear between delete and rename.
  (setq f (open (dsh:path "heartbeat.lsp") "w"))
  (if f
    (progn
      (dsh:emit f (list
        (list "version" "1")
        (list "activeX" (if dsh:activex 1 0))
        (list "document" (getvar "DWGNAME"))))
      (princ "\n" f)
      (close f))))

(defun dsh:dispatch (id form / op)
  (setq op (dsh:get form "op"))
  (cond
    ((= op "addHatch") (dsh:defer id form "hatch"))
    ((= op "runCommand") (dsh:defer id form "command"))
    (t (dsh:dispatch-now id form op))))

(defun dsh:dispatch-now (id form op)
  (cond
    ((= op "status") (dsh:status id))
    ((= op "listLayers") (dsh:layers id))
    ((= op "queryEntities") (dsh:query id form))
    ((= op "getEntity") (dsh:get-entity id form))
    ((= op "draw") (dsh:draw id form))
    ((= op "modify") (dsh:modify id form))
    ((= op "transform") (dsh:transform id form))
    ((= op "delete") (dsh:delete id form))
    ((= op "addDimension") (dsh:add-dim id form))
    ((= op "open") (dsh:open id form))
    ((= op "saveAs") (dsh:save-as id form))
    (t (dsh:fail id "UNSUPPORTED" (strcat "unsupported op: " (if op op "?"))))))

(defun dsh:defer (id form kind / err)
  (if (not dsh:activex)
    (dsh:fail id "UNSUPPORTED" "this op needs ActiveX, which is not available")
    (progn
      (setq dsh:pending (list id form kind))
      (setq dsh:busy T)
      (setq dsh:busy-since (dsh:now))
      (setq err (vl-catch-all-apply
        'vla-SendCommand
        (list (dsh:doc) "(dsh:run-pending)\n")))
      (if (vl-catch-all-error-p err)
        (progn
          (setq dsh:pending nil dsh:busy nil)
          (dsh:fail id "UNSUPPORTED" (vl-catch-all-error-message err)))))))

(defun dsh:run-pending (/ pending id form kind err)
  (setq pending dsh:pending)
  (setq dsh:pending nil)
  (if pending
    (progn
      (setq id (car pending) form (cadr pending) kind (caddr pending))
      (setq err (vl-catch-all-apply 'dsh:run-pending-body (list id form kind)))
      (if (vl-catch-all-error-p err)
        (dsh:fail id "BACKEND_ERROR" (vl-catch-all-error-message err)))
      (setq dsh:busy nil)
      (dsh:write-heartbeat))))

(defun dsh:run-pending-body (id form kind)
  (cond
    ((= kind "hatch") (dsh:hatch-now id form))
    ((= kind "command") (dsh:command-now id form))
    (t (dsh:fail id "BACKEND_ERROR" "unknown deferred op"))))

(defun dsh:status (id / path)
  (setq path (dsh:doc-path))
  (dsh:ok id
    (list
      (list "backend" "lisp-ipc")
      (list "document"
        (list
          (list "name" (getvar "DWGNAME"))
          (list "path" path)
          (list "unitsName" (itoa (getvar "INSUNITS")))
          (list "modelSpaceCount" (dsh:model-count))
          (list "activeSpace" (if (= (getvar "TILEMODE") 1) "model" "paper")))))
    nil nil))

(defun dsh:layers (id / rec layers counts name flags color lt)
  (setq counts (dsh:layer-counts))
  (setq layers nil)
  (setq rec (tblnext "LAYER" T))
  (while rec
    (setq name (cdr (assoc 2 rec)))
    (setq flags (cdr (assoc 70 rec)))
    (if (null flags) (setq flags 0))
    (setq color (cdr (assoc 62 rec)))
    (if (null color) (setq color 7))
    (setq lt (cdr (assoc 6 rec)))
    (if (null lt) (setq lt "Continuous"))
    (setq layers (append layers (list (list
      (list "name" name)
      (list "color" (abs color))
      (list "linetype" lt)
      (list "on" (if (< color 0) 0 1))
      (list "frozen" (if (dsh:bit flags 1) 1 0))
      (list "locked" (if (dsh:bit flags 4) 1 0))
      (list "entityCount" (dsh:count-of counts name))))))
    (setq rec (tblnext "LAYER")))
  (dsh:ok id (list (list "layers" layers)) nil nil))

(defun dsh:query (id form / layer kind text window limit found n e)
  (setq layer (dsh:get form "layer"))
  (setq kind (dsh:get form "kind"))
  (setq text (dsh:get form "textContains"))
  (setq window (dsh:get form "window"))
  (setq limit (dsh:get form "limit"))
  (if (or (null limit) (not (numberp limit))) (setq limit 100))
  (setq found nil n 0 e (entnext))
  (while (and e (< n limit))
    (if (dsh:match e layer kind text window)
      (progn
        (setq found (append found (list (dsh:entity e))))
        (setq n (1+ n))))
    (setq e (entnext e)))
  (dsh:ok id (list (list "count" n) (list "entities" found)) nil nil))

(defun dsh:get-entity (id form / handle en)
  (setq handle (dsh:get form "handle"))
  (setq en (dsh:find handle))
  (if (null en)
    (dsh:fail id "NOT_FOUND" (strcat "图元不存在: " (if handle handle "")))
    (dsh:ok id (list (list "entity" (dsh:entity en))) nil nil)))

(defun dsh:draw (id form / items handles warnings item made)
  (setq items (dsh:get form "items"))
  (if (not (listp items))
    (dsh:fail id "INVALID_ARGUMENT" "draw 缺少 items")
    (progn
      (setq handles nil warnings nil)
      (foreach item items
        (setq made (dsh:draw-one item))
        (if (car made)
          (setq handles (append handles (list (car made))))
          (if (cadr made) (setq warnings (append warnings (list (cadr made))))))
        (if (and (car made) (caddr made))
          (setq warnings (append warnings (list (caddr made))))))
      (if (null handles)
        (dsh:fail id "INVALID_ARGUMENT" (if warnings (car warnings) "没有创建任何图元"))
        (dsh:ok id (list (list "count" (length handles))) handles warnings)))))

(defun dsh:draw-one (spec / kind)
  (setq kind (dsh:get spec "kind"))
  (cond
    ((= kind "line") (dsh:make-line spec))
    ((= kind "circle") (dsh:make-circle spec))
    ((= kind "arc") (dsh:make-arc spec))
    ((= kind "polyline") (dsh:make-pline spec))
    ((= kind "text") (dsh:make-text spec nil))
    ((= kind "mtext") (dsh:make-text spec T))
    (t (list nil (strcat "不支持的图元类型: " (if kind kind "?"))))))

(defun dsh:make-line (spec / a b en note)
  (setq a (dsh:pt (dsh:get spec "start")))
  (setq b (dsh:pt (dsh:get spec "end")))
  (if (or (null a) (null b))
    (list nil "直线缺少端点")
    (progn
      (if (dsh:same-pt a b) (setq note "零长度直线"))
      (setq en (entmake (dsh:common
        (list '(0 . "LINE") (cons 10 a) (cons 11 b)) spec)))
      (dsh:made en note))))

(defun dsh:make-circle (spec / c r en)
  (setq c (dsh:pt (dsh:get spec "center")))
  (setq r (dsh:num (dsh:get spec "radius")))
  (if (or (null c) (<= r 0.0))
    (list nil "圆缺少圆心或半径无效")
    (dsh:made (entmake (dsh:common
      (list '(0 . "CIRCLE") (cons 10 c) (cons 40 r)) spec)) nil)))

(defun dsh:make-arc (spec / c r en)
  (setq c (dsh:pt (dsh:get spec "center")))
  (setq r (dsh:num (dsh:get spec "radius")))
  (if (or (null c) (<= r 0.0))
    (list nil "圆弧缺少圆心或半径无效")
    (dsh:made (entmake (dsh:common
      (list '(0 . "ARC") (cons 10 c) (cons 40 r)
            (cons 50 (dsh:rad (dsh:num (dsh:get spec "startAngle"))))
            (cons 51 (dsh:rad (dsh:num (dsh:get spec "endAngle")))))
      spec)) nil)))

(defun dsh:make-pline (spec / verts closed data p en)
  (setq verts (dsh:get spec "vertices"))
  (if (or (not (listp verts)) (< (length verts) 2))
    (list nil "多段线至少需要 2 个顶点")
    (progn
      (setq closed (= (dsh:get spec "closed") 1))
      (setq data (list '(0 . "LWPOLYLINE")
                       '(100 . "AcDbEntity")
                       '(100 . "AcDbPolyline")
                       (cons 90 (length verts))
                       (cons 70 (if closed 1 0))))
      (foreach p verts
        (setq data (append data (list (cons 10 (dsh:pt p))))))
      (setq en (entmake (dsh:common data spec)))
      (dsh:made en nil))))

(defun dsh:make-text (spec mtext / pos text height width data en)
  (setq pos (dsh:pt (dsh:get spec "position")))
  (setq text (dsh:get spec "text"))
  (if (null text) (setq text ""))
  (setq height (dsh:num (dsh:get spec "height")))
  (if (<= height 0.0) (setq height 2.5))
  (if (null pos)
    (list nil "文字缺少插入点")
    (progn
      (if mtext
        (progn
          (setq width (dsh:num (dsh:get spec "width")))
          (if (<= width 0.0) (setq width 100.0))
          (setq data (list '(0 . "MTEXT")
                           '(100 . "AcDbEntity")
                           '(100 . "AcDbMText")
                           (cons 10 pos)
                           (cons 40 height)
                           (cons 41 width)
                           (cons 1 text))))
        (setq data (list '(0 . "TEXT")
                         (cons 10 pos)
                         (cons 40 height)
                         (cons 1 text)
                         (cons 50 (dsh:rad (dsh:num (dsh:get spec "rotation")))))))
      (dsh:made (entmake (dsh:common data spec)) nil))))

(defun dsh:modify (id form / handle set en d name)
  (setq handle (dsh:get form "handle"))
  (setq set (dsh:get form "set"))
  (setq en (dsh:find handle))
  (if (null en)
    (dsh:fail id "NOT_FOUND" (strcat "图元不存在: " (if handle handle "")))
    (progn
      (setq d (entget en))
      (setq name (cdr (assoc 0 d)))
      (if (dsh:has set "layer")
        (progn
          (dsh:ensure-layer (dsh:get set "layer"))
          (setq d (dsh:put d 8 (dsh:get set "layer")))))
      (if (dsh:has set "color")
        (setq d (dsh:put d 62 (dsh:int (dsh:get set "color")))))
      (if (dsh:has set "linetype")
        (setq d (dsh:put d 6 (dsh:get set "linetype"))))
      (if (dsh:has set "text")
        (setq d (dsh:put d 1 (dsh:get set "text"))))
      (if (dsh:has set "height")
        (setq d (dsh:put d 40 (dsh:num (dsh:get set "height")))))
      (if (dsh:has set "rotation")
        (setq d (dsh:put d 50 (dsh:rad (dsh:num (dsh:get set "rotation"))))))
      (if (dsh:has set "radius")
        (if (or (= name "CIRCLE") (= name "ARC"))
          (setq d (dsh:put d 40 (dsh:num (dsh:get set "radius"))))
          (progn
            (entmod d)
            (dsh:fail id "INVALID_ARGUMENT" "半径只能改圆或圆弧")
            (setq d nil))))
      (if d
        (if (null (entmod d))
          (dsh:fail id "BACKEND_ERROR" "entmod 失败")
          (if (null (dsh:find handle))
            (dsh:fail id "BACKEND_ERROR" "修改后无法再次定位")
            (dsh:ok id (list (list "count" 1)) (list handle) nil)))))))

(defun dsh:warn (msg)
  (setq dsh:warns (append (if (listp dsh:warns) dsh:warns '()) (list msg))))

(defun dsh:transform (id form / handles mode value valueY center copy done h en)
  (setq handles (dsh:get form "handles"))
  (setq mode (dsh:get form "mode"))
  (setq value (dsh:num (dsh:get form "value")))
  (setq valueY (dsh:num (dsh:get form "valueY")))
  (setq center (dsh:pt (dsh:get form "center")))
  (setq copy (= (dsh:get form "copy") 1))
  (setq done nil dsh:warns nil)
  (if (not (listp handles))
    (dsh:fail id "INVALID_ARGUMENT" "transform 缺少 handles")
    (progn
      (foreach h handles
        (setq en (dsh:find h))
        (if (null en)
          (dsh:warn (strcat "图元不存在: " h))
          (setq en (dsh:transform-one en mode value valueY center copy)))
        (if (and en (dsh:find (dsh:handle-of en)))
          (setq done (append done (list (dsh:handle-of en))))))
      (if (and (null done) (null dsh:warns))
        (dsh:fail id "BACKEND_ERROR" "transform 没有改到任何图元")
        (dsh:ok id (list (list "count" (length done))) done dsh:warns)))))

(defun dsh:transform-one (en mode value valueY center copy / err)
  (if copy
    (if (not dsh:activex)
      (progn (dsh:warn "复制需要 ActiveX") (setq en nil))
      (progn
        (setq err (vl-catch-all-apply 'vla-Copy (list (vlax-ename->vla-object en))))
        (if (vl-catch-all-error-p err)
          (progn (dsh:warn (vl-catch-all-error-message err)) (setq en nil))
          (setq en (vlax-vla-object->ename err))))))
  (if (null en)
    nil
    (cond
      ((= mode "move")
        (if (dsh:move-ent en value valueY)
          en
          (if dsh:activex
            (dsh:vla-move en value valueY)
            (progn (dsh:warn "该图元不能平移") nil))))
      ((or (= mode "rotate") (= mode "scale"))
        (if (not dsh:activex)
          (progn (dsh:warn "旋转/缩放需要 ActiveX") nil)
          (dsh:vla-rotate-scale en mode value center)))
      (t (dsh:warn "未知变换") nil))))

(defun dsh:move-ent (en dx dy / d name p)
  (setq d (entget en))
  (setq name (cdr (assoc 0 d)))
  (cond
    ((= name "LINE")
      (setq d (dsh:put d 10 (dsh:add (cdr (assoc 10 d)) dx dy)))
      (setq d (dsh:put d 11 (dsh:add (cdr (assoc 11 d)) dx dy)))
      (entmod d))
    ((or (= name "CIRCLE") (= name "ARC") (= name "TEXT") (= name "MTEXT")
         (= name "POINT") (= name "INSERT") (= name "ELLIPSE"))
      (setq d (dsh:put d 10 (dsh:add (cdr (assoc 10 d)) dx dy)))
      (entmod d))
    ((= name "LWPOLYLINE")
      (setq d (mapcar
        '(lambda (g)
           (if (= (car g) 10)
             (cons 10 (dsh:add (cdr g) dx dy))
             g))
        d))
      (entmod d))
    (t nil)))

(defun dsh:vla-move (en dx dy / obj err)
  (setq obj (vlax-ename->vla-object en))
  (setq err (vl-catch-all-apply 'vla-Move
    (list obj (vlax-3d-point 0 0 0) (vlax-3d-point dx dy 0))))
  (if (vl-catch-all-error-p err) nil en))

(defun dsh:vla-rotate-scale (en mode value center / obj err)
  (if (null center)
    (progn (dsh:warn "旋转/缩放缺少基准点") nil)
    (progn
      (setq obj (vlax-ename->vla-object en))
      (setq err (vl-catch-all-apply
        (if (= mode "rotate") 'vla-Rotate 'vla-ScaleEntity)
        (list obj (vlax-3d-point (car center) (cadr center) 0.0)
              (if (= mode "rotate") (dsh:rad value) value))))
      (if (vl-catch-all-error-p err)
        (progn (dsh:warn (vl-catch-all-error-message err)) nil)
        en))))

(defun dsh:delete (id form / handles done warnings h en)
  (setq handles (dsh:get form "handles"))
  (setq done nil warnings nil)
  (if (not (listp handles))
    (dsh:fail id "INVALID_ARGUMENT" "delete 缺少 handles")
    (progn
      (foreach h handles
        (setq en (dsh:find h))
        (if (null en)
          (setq warnings (append warnings (list (strcat "图元不存在: " h))))
          (progn
            (entdel en)
            ;; handent still returns a just-deleted entity in this AutoCAD.
            ;; entget returns nil once the entity is actually gone.
            (if (entget en)
              (setq warnings (append warnings (list (strcat "无法删除: " h))))
              (setq done (append done (list h)))))))
      (if (and (null done) (null warnings))
        (dsh:fail id "BACKEND_ERROR" "delete 没有改到任何图元")
        (dsh:ok id (list (list "count" (length done))) done warnings)))))

(defun dsh:add-dim (id form / kind pts)
  (if (not dsh:activex)
    (dsh:fail id "UNSUPPORTED" "标注需要 ActiveX")
    (progn
      (setq kind (dsh:get form "kind"))
      (setq pts (dsh:get form "points"))
      (cond
        ((and (or (= kind "linear") (= kind "aligned")) (not (dsh:n-pts pts 2)))
          (dsh:fail id "INVALID_ARGUMENT" "线性/对齐标注需要 2 个点"))
        ((and (= kind "angular") (not (dsh:n-pts pts 3)))
          (dsh:fail id "INVALID_ARGUMENT" "角度标注需要 3 个点"))
        ((and (or (= kind "radius") (= kind "diameter")) (not (dsh:n-pts pts 1)))
          (dsh:fail id "INVALID_ARGUMENT" "半径/直径标注需要 1 个点"))
        (t (dsh:add-dim-now id form kind pts))))))

(defun dsh:add-dim-now (id form kind pts / space err obj handle p1 p2 p3 off dimpt)
  (setq space (vla-get-ModelSpace (dsh:doc)))
  (setq off (dsh:num (dsh:get form "offset")))
  (if (= off 0.0) (setq off 10.0))
  (setq p1 (dsh:pt (car pts)))
  (setq p2 (dsh:pt (cadr pts)))
  (setq p3 (dsh:pt (caddr pts)))
  (setq dimpt (if p2 (dsh:dim-point p1 p2 off) p1))
  (setq err (vl-catch-all-apply
    (cond
      ((= kind "linear") 'vla-AddDimRotated)
      ((= kind "aligned") 'vla-AddDimAligned)
      ((= kind "angular") 'vla-AddDimAngular)
      ((= kind "radius") 'vla-AddDimRadial)
      ((= kind "diameter") 'vla-AddDimDiametric)
      (t nil))
    (cond
      ((= kind "linear")
        (list space (vlax-3d-point (car p1) (cadr p1) 0)
              (vlax-3d-point (car p2) (cadr p2) 0)
              (vlax-3d-point (car dimpt) (cadr dimpt) 0)
              (if (>= (abs (- (car p2) (car p1))) (abs (- (cadr p2) (cadr p1)))) 0.0 (/ pi 2.0))))
      ((= kind "aligned")
        (list space (vlax-3d-point (car p1) (cadr p1) 0)
              (vlax-3d-point (car p2) (cadr p2) 0)
              (vlax-3d-point (car dimpt) (cadr dimpt) 0)))
      ((= kind "angular")
        (list space (vlax-3d-point (car p2) (cadr p2) 0)
              (vlax-3d-point (car p1) (cadr p1) 0)
              (vlax-3d-point (car p3) (cadr p3) 0)
              (vlax-3d-point (car dimpt) (cadr dimpt) 0)))
      ((= kind "radius")
        (list space (vlax-3d-point (car p1) (cadr p1) 0)
              (vlax-3d-point (+ (car p1) off) (cadr p1) 0) off))
      ((= kind "diameter")
        (list space (vlax-3d-point (- (car p1) off) (cadr p1) 0)
              (vlax-3d-point (+ (car p1) off) (cadr p1) 0) off))
      (t nil))))
  (if (or (null err) (vl-catch-all-error-p err))
    (dsh:fail id "BACKEND_ERROR"
      (if (vl-catch-all-error-p err) (vl-catch-all-error-message err) "无法创建标注"))
    (progn
      (setq obj err)
      (dsh:style-obj obj form)
      (setq handle (vl-catch-all-apply 'vla-get-Handle (list obj)))
      (if (or (vl-catch-all-error-p handle) (null (dsh:find handle)))
        (dsh:fail id "BACKEND_ERROR" "标注创建后无法读回句柄")
        (dsh:ok id (list (list "count" 1)) (list handle) nil)))))

(defun dsh:hatch-now (id form / loops bounds loop pts p en pattern scale err hatch handle ss)
  (setq loops (dsh:get form "loops"))
  (if (or (not (listp loops)) (null loops))
    (dsh:fail id "INVALID_ARGUMENT" "填充缺少边界")
    (progn
      (setq bounds nil)
      (foreach loop loops
        (if (or (not (listp loop)) (< (length loop) 3))
          (setq err "每个边界环至少 3 个顶点")
          (progn
            (setq pts nil)
            (foreach p loop (setq pts (append pts (list (dsh:pt p)))))
            (setq en (dsh:make-closed pts))
            (if en (setq bounds (append bounds (list en))) (setq err "边界多段线创建失败")))))
      (if err
        (progn (dsh:delete-ents bounds) (dsh:fail id "INVALID_ARGUMENT" err))
        (progn
          (setq pattern (dsh:get form "patternName"))
          (if (or (null pattern) (= pattern "")) (setq pattern "SOLID"))
          (setq scale (dsh:num (dsh:get form "patternScale")))
          (if (<= scale 0.0) (setq scale 1.0))
          (setvar "HPNAME" pattern)
          (if (/= (strcase pattern) "SOLID") (setvar "HPSCALE" scale))
          (setq ss (ssadd))
          (foreach en bounds (ssadd en ss))
          (command "_.-HATCH" "_S" ss "" "")
          (setq hatch (entlast))
          (if (or (null hatch) (/= (cdr (assoc 0 (entget hatch))) "HATCH"))
            (progn
              (dsh:delete-ents bounds)
              (dsh:fail id "BACKEND_ERROR" "AutoCAD 未生成填充对象"))
            (progn
              (setq handle (cdr (assoc 5 (entget hatch))))
              (dsh:delete-ents bounds)
              (if (null (dsh:find handle))
                (dsh:fail id "BACKEND_ERROR" (strcat "填充对象创建后无法再次定位(句柄 " handle ")"))
                (dsh:ok id (list (list "count" 1)) (list handle) nil)))))))))

(defun dsh:command-now (id form / cmd args)
  (setq cmd (dsh:get form "command"))
  (setq args (dsh:get form "args"))
  (if (or (null cmd) (= cmd ""))
    (dsh:fail id "INVALID_ARGUMENT" "命令名为空")
    (progn
      (command cmd)
      (if (listp args) (foreach a args (command a)))
      (command "")
      (dsh:ok id (list (list "executed" (list cmd))) nil nil))))

(defun dsh:open (id form / path err doc)
  (setq path (dsh:get form "path"))
  (if (or (null path) (= path ""))
    (dsh:fail id "INVALID_ARGUMENT" "open 缺少路径")
    (if (not dsh:activex)
      (dsh:fail id "UNSUPPORTED" "打开图纸需要 ActiveX")
      (progn
        (setq err (vl-catch-all-apply 'vla-Open
          (list (vla-get-Documents (vlax-get-acad-object)) path)))
        (if (vl-catch-all-error-p err)
          (dsh:fail id "BACKEND_ERROR" (vl-catch-all-error-message err))
          (dsh:ok id
            (list
              (list "name" (getvar "DWGNAME"))
              (list "path" (dsh:doc-path))
              (list "modelSpaceCount" (dsh:model-count)))
            nil nil))))))

(defun dsh:save-as (id form / path err)
  (setq path (dsh:get form "path"))
  (if (or (null path) (= path ""))
    (dsh:fail id "INVALID_ARGUMENT" "saveAs 缺少路径")
    (if (not dsh:activex)
      (dsh:fail id "UNSUPPORTED" "另存图纸需要 ActiveX")
      (progn
        (setq err (vl-catch-all-apply 'vla-SaveAs (list (dsh:doc) path)))
        (if (vl-catch-all-error-p err)
          (dsh:fail id "BACKEND_ERROR" (vl-catch-all-error-message err))
          (dsh:ok id (list (list "path" path)) nil nil))))))

(defun dsh:entity (e / d name kind handle layer color lt text box meas out)
  (setq d (entget e))
  (setq name (cdr (assoc 0 d)))
  (setq kind (dsh:kind name))
  (setq handle (cdr (assoc 5 d)))
  (setq layer (cdr (assoc 8 d)))
  (if (null layer) (setq layer "0"))
  (setq color (cdr (assoc 62 d)))
  (if (null color) (setq color 256))
  (setq lt (cdr (assoc 6 d)))
  (if (null lt) (setq lt "ByLayer"))
  (setq text (cdr (assoc 1 d)))
  (if (= kind "block") (setq text (cdr (assoc 2 d))))
  (setq box (dsh:bbox e d))
  (setq meas (dsh:measure e d kind))
  (setq out (list
    (list "handle" handle)
    (list "kind" kind)
    (list "layer" layer)
    (list "color" color)
    (list "linetype" lt)))
  (if text (setq out (append out (list (list "text" text)))))
  (if box (setq out (append out (list (list "bbox" box)))))
  (if meas (setq out (append out (list (list "measure" meas)))))
  out)

(defun dsh:kind (name)
  (cond
    ((= name "LINE") "line")
    ((= name "CIRCLE") "circle")
    ((= name "ARC") "arc")
    ((or (= name "LWPOLYLINE") (= name "POLYLINE")) "polyline")
    ((= name "TEXT") "text")
    ((= name "MTEXT") "mtext")
    ((= name "HATCH") "hatch")
    ((= name "POINT") "point")
    ((= name "ELLIPSE") "ellipse")
    ((= name "SPLINE") "spline")
    ((= name "INSERT") "block")
    ((and name (wcmatch name "*DIMENSION")) "dimension")
    (t "unknown")))

(defun dsh:measure (e d kind / a b r ang)
  (cond
    ((= kind "line")
      (setq a (cdr (assoc 10 d)) b (cdr (assoc 11 d)))
      (list (list "length" (distance a b))))
    ((= kind "circle")
      (setq r (cdr (assoc 40 d)))
      (list (list "radius" r) (list "area" (* pi r r))))
    ((= kind "arc")
      (setq r (cdr (assoc 40 d)))
      (setq ang (abs (- (cdr (assoc 51 d)) (cdr (assoc 50 d)))))
      (list (list "radius" r) (list "angle" (* ang (/ 180.0 pi)))))
    ((= kind "polyline")
      (list (list "length" (dsh:pline-length d))))
    ((= kind "hatch")
      (dsh:hatch-measure e))
    (t nil)))

(defun dsh:hatch-measure (e / err area)
  (if (not dsh:activex)
    nil
    (progn
      (setq err (vl-catch-all-apply 'vla-get-Area (list (vlax-ename->vla-object e))))
      (if (vl-catch-all-error-p err) nil (list (list "area" err))))))

(defun dsh:bbox (e d / name a b r pts minx miny maxx maxy p)
  (setq name (cdr (assoc 0 d)))
  (cond
    ((= name "LINE")
      (setq a (cdr (assoc 10 d)) b (cdr (assoc 11 d)))
      (dsh:box2 (min (car a) (car b)) (min (cadr a) (cadr b))
                (max (car a) (car b)) (max (cadr a) (cadr b))))
    ((or (= name "CIRCLE") (= name "ARC"))
      (setq a (cdr (assoc 10 d)) r (cdr (assoc 40 d)))
      (dsh:box2 (- (car a) r) (- (cadr a) r) (+ (car a) r) (+ (cadr a) r)))
    ((= name "LWPOLYLINE")
      (setq pts (dsh:pts-10 d))
      (if pts (dsh:box-pts pts) nil))
    (t
      (setq a (cdr (assoc 10 d)))
      (if a (dsh:box2 (car a) (cadr a) (car a) (cadr a)) nil))))

(defun dsh:box2 (x0 y0 x1 y1)
  (list
    (list "min" (list (list "x" x0) (list "y" y0) (list "z" 0.0)))
    (list "max" (list (list "x" x1) (list "y" y1) (list "z" 0.0)))))

(defun dsh:box-pts (pts / minx miny maxx maxy p)
  (setq minx (car (car pts)) miny (cadr (car pts)) maxx minx maxy miny)
  (foreach p pts
    (if (< (car p) minx) (setq minx (car p)))
    (if (< (cadr p) miny) (setq miny (cadr p)))
    (if (> (car p) maxx) (setq maxx (car p)))
    (if (> (cadr p) maxy) (setq maxy (cadr p))))
  (dsh:box2 minx miny maxx maxy))

(defun dsh:pts-10 (d / pts)
  (setq pts nil)
  (foreach g d
    (if (= (car g) 10) (setq pts (append pts (list (cdr g))))))
  pts)

(defun dsh:pline-length (d / pts n i a b total)
  (setq pts (dsh:pts-10 d) total 0.0 n (length pts) i 0)
  (while (< i (1- n))
    (setq a (nth i pts) b (nth (1+ i) pts))
    (setq total (+ total (distance a b)))
    (setq i (1+ i)))
  (if (= (logand (if (cdr (assoc 70 d)) (cdr (assoc 70 d)) 0) 1) 1)
    (setq total (+ total (distance (nth (1- n) pts) (car pts)))))
  total)

(defun dsh:match (e layer kind text window / d name)
  (setq d (entget e))
  (setq name (cdr (assoc 0 d)))
  (and
    (not (dsh:paper-p d))
    (not (dsh:skip-name name))
    (or (null layer) (= (strcase layer) (strcase (cdr (assoc 8 d)))))
    (or (null kind) (= kind (dsh:kind name)))
    (or (null text) (= text "") (dsh:text-hit d text))
    (dsh:window-hit d window)))

(defun dsh:text-hit (d needle / text)
  (setq text (cdr (assoc 1 d)))
  (if (null text) (setq text (cdr (assoc 2 d))))
  (and text (dsh:contains text needle)))

(defun dsh:window-hit (d window / box minp maxp)
  (if (null window)
    T
    (progn
      (setq box (dsh:bbox nil d))
      (if (null box)
        T
        (dsh:overlap
          (dsh:pt (dsh:get (dsh:get box "min") "x"))
          box window)))))

(defun dsh:overlap (unused box window / bmin bmax wmin wmax)
  (setq bmin (dsh:pt (dsh:get box "min")))
  (setq bmax (dsh:pt (dsh:get box "max")))
  (setq wmin (dsh:pt (dsh:get window "min")))
  (setq wmax (dsh:pt (dsh:get window "max")))
  (and bmin bmax wmin wmax
    (<= (car bmin) (car wmax))
    (<= (car wmin) (car bmax))
    (<= (cadr bmin) (cadr wmax))
    (<= (cadr wmin) (cadr bmax))))

(defun dsh:paper-p (d)
  (= (cdr (assoc 67 d)) 1))

(defun dsh:skip-name (name)
  (or (= name "VERTEX") (= name "SEQEND") (= name "ATTRIB")
      (= name "ATTDEF") (= name "VIEWPORT")))

(defun dsh:model-count (/ e n)
  (setq n 0 e (entnext))
  (while e
    (if (dsh:match e nil nil nil nil) (setq n (1+ n)))
    (setq e (entnext e)))
  n)

(defun dsh:layer-counts (/ e counts d name hit)
  (setq counts nil e (entnext))
  (while e
    (if (dsh:match e nil nil nil nil)
      (progn
        (setq d (entget e))
        (setq name (cdr (assoc 8 d)))
        (setq hit (assoc name counts))
        (if hit
          (setq counts (subst (cons name (1+ (cdr hit))) hit counts))
          (setq counts (cons (cons name 1) counts)))))
    (setq e (entnext e)))
  counts)

(defun dsh:count-of (counts name / hit)
  (setq hit (assoc name counts))
  (if hit (cdr hit) 0))

(defun dsh:put (data code value / hit)
  (setq hit (assoc code data))
  (if hit
    (subst (cons code value) hit data)
    (append data (list (cons code value)))))

(defun dsh:common (data spec / layer color)
  (setq layer (dsh:get spec "layer"))
  (if (and layer (/= layer ""))
    (progn
      (dsh:ensure-layer layer)
      (setq data (dsh:put data 8 layer))))
  (if (dsh:has spec "color")
    (setq data (dsh:put data 62 (dsh:int (dsh:get spec "color")))))
  data)

(defun dsh:ensure-layer (name)
  (if (and name (/= name "") (null (tblsearch "LAYER" name)))
    (entmake (list '(0 . "LAYER") (cons 2 name) '(70 . 0) '(62 . 7)))))

(defun dsh:as-ename (en)
  (cond
    ((null en) nil)
    ((= (type en) 'ENAME) en)
    (t (entlast))))

(defun dsh:made (en note / handle)
  ;; This AutoCAD returns the definition list from entmake, not an ename.
  (setq en (dsh:as-ename en))
  (if (null en)
    (list nil "entmake 失败")
    (progn
      (setq handle (dsh:handle-of en))
      (if (or (null handle) (null (dsh:find handle)))
        (list nil "创建后无法读回句柄")
        (list handle nil note)))))

(defun dsh:make-closed (pts / data p en)
  (setq data (list '(0 . "LWPOLYLINE")
                   '(100 . "AcDbEntity")
                   '(100 . "AcDbPolyline")
                   (cons 90 (length pts))
                   '(70 . 1)))
  (foreach p pts (setq data (append data (list (cons 10 p)))))
  (dsh:as-ename (entmake data)))

(defun dsh:delete-ents (ents / en)
  (foreach en ents (if en (entdel en))))

(defun dsh:style-obj (obj form / layer text err)
  (setq layer (dsh:get form "layer"))
  (if (and layer (/= layer ""))
    (progn
      (dsh:ensure-layer layer)
      (vl-catch-all-apply 'vla-put-Layer (list obj layer))))
  (if (dsh:has form "color")
    (vl-catch-all-apply 'vla-put-Color (list obj (dsh:int (dsh:get form "color")))))
  (setq text (dsh:get form "textOverride"))
  (if (and text (/= text ""))
    (vl-catch-all-apply 'vla-put-TextOverride (list obj text))))

(defun dsh:find (handle / en)
  ;; handent still returns a just-deleted entity. entget is nil once it is gone.
  (if (and handle (= (type handle) 'STR) (/= handle ""))
    (progn
      (setq en (handent handle))
      (if (and en (entget en)) en nil))
    nil))

(defun dsh:handle-of (en)
  (cdr (assoc 5 (entget en))))

(defun dsh:doc ()
  (vla-get-ActiveDocument (vlax-get-acad-object)))

(defun dsh:doc-path (/ pre name)
  (setq pre (getvar "DWGPREFIX"))
  (setq name (getvar "DWGNAME"))
  (if (or (null pre) (= pre "")) nil (strcat pre name)))

(defun dsh:n-pts (pts n)
  (and (listp pts) (>= (length pts) n)))

(defun dsh:dim-point (p1 p2 offset / dx dy len)
  (setq dx (- (car p2) (car p1)) dy (- (cadr p2) (cadr p1)))
  (setq len (sqrt (+ (* dx dx) (* dy dy))))
  (if (< len 1e-9)
    p1
    (list
      (+ (car p1) (* (/ (- dy) len) offset))
      (+ (cadr p1) (* (/ dx len) offset))
      0.0)))

(defun dsh:ok (id data handles warnings)
  (dsh:write-form
    (strcat "res-" id ".lsp")
    (list
      (list "ok" 1)
      (list "data" data)
      (list "handles" handles)
      (list "warnings" warnings))))

(defun dsh:fail (id code message)
  (dsh:write-form
    (strcat "res-" id ".lsp")
    (list
      (list "ok" 0)
      (list "code" code)
      (list "message" message))))

(defun dsh:write-form (name form / tmp final f)
  (setq tmp (dsh:path (strcat name ".tmp")))
  (setq final (dsh:path name))
  (setq f (open tmp "w"))
  (if f
    (progn
      (dsh:emit f form)
      (princ "\n" f)
      (close f)
      (dsh:commit tmp final))))

(defun dsh:commit (tmp final)
  (dsh:delete-file final)
  (if (and dsh:has-vl (vl-file-rename tmp final))
    T
    (if (and dsh:has-vl (vl-file-copy tmp final))
      T
      nil)))

(defun dsh:next-request (/ dir names)
  (if (not dsh:has-vl)
    nil
    (progn
      (setq dir (dsh:dir))
      (setq names (vl-catch-all-apply 'vl-directory-files (list dir "req-*.lsp" 1)))
      (if (or (vl-catch-all-error-p names) (null names))
        nil
        (dsh:path (car names))))))

(defun dsh:request-id (path / name)
  (setq name (vl-filename-base path))
  (if (and name (> (strlen name) 4)) (substr name 5) nil))

(defun dsh:dir (/ root n)
  (setq root (dsh:root))
  (setq n (strlen root))
  (if (and (> n 0) (wcmatch (substr root n 1) "\\,/"))
    (substr root 1 (1- n))
    root))

(defun dsh:slurp (f / line acc)
  (setq acc "")
  (while (setq line (read-line f))
    (setq acc (strcat acc line)))
  acc)

(defun dsh:read-file (path / f acc parsed)
  ;; read consumes a string, not a file handle. Passing the handle aborts
  ;; the tick before close, and the leaked handle locks the file.
  (setq f (open path "r"))
  (if (null f)
    nil
    (progn
      (setq acc (vl-catch-all-apply 'dsh:slurp (list f)))
      (close f)
      (if (vl-catch-all-error-p acc)
        nil
        (progn
          (setq parsed (vl-catch-all-apply 'read (list acc)))
          (if (vl-catch-all-error-p parsed) nil parsed))))))

(defun dsh:delete-file (path)
  (if dsh:has-vl
    (vl-file-delete (vl-string-translate "/" "\\" path))))

(defun dsh:ensure-dir (/ root parent)
  (setq root (dsh:root))
  (if dsh:has-vl
    (progn
      (setq parent (vl-filename-directory root))
      (if parent (vl-mkdir parent))
      (vl-mkdir root))))

(defun dsh:root ()
  (if dsh:ipc-dir
    dsh:ipc-dir
    (strcat (getenv "LOCALAPPDATA") "\\dsh-cad\\ipc\\")))

(defun dsh:path (name / root)
  (setq root (dsh:root))
  (if (not (wcmatch root "*\\,*/"))
    (setq root (strcat root "\\")))
  (strcat root name))

(defun dsh:get (form key / hit)
  (if (not (listp form))
    nil
    (progn
      (setq hit (assoc key form))
      (if hit (cadr hit) nil))))

(defun dsh:has (form key)
  (and (listp form) (assoc key form)))

(defun dsh:num (v)
  (cond
    ((= (type v) 'INT) (float v))
    ((= (type v) 'REAL) v)
    (t 0.0)))

(defun dsh:int (v)
  (cond
    ((= (type v) 'INT) v)
    ((= (type v) 'REAL) (fix v))
    (t 0)))

(defun dsh:pt (form)
  (if (or (null form) (not (listp form)))
    nil
    (list
      (dsh:num (dsh:get form "x"))
      (dsh:num (dsh:get form "y"))
      (if (dsh:has form "z") (dsh:num (dsh:get form "z")) 0.0))))

(defun dsh:rad (deg)
  (* deg (/ pi 180.0)))

(defun dsh:same-pt (a b)
  (and (equal (car a) (car b) 1e-9) (equal (cadr a) (cadr b) 1e-9)))

(defun dsh:add (p dx dy)
  (list (+ (car p) dx) (+ (cadr p) dy) (if (caddr p) (caddr p) 0.0)))

(defun dsh:bit (flags bit)
  (and (member "LOGAND" (atoms-family 1)) (= (logand flags bit) bit)))

(defun dsh:contains (hay needle)
  (and hay needle
    (if (and dsh:has-vl (member "VL-STRING-SEARCH" (atoms-family 1)))
      (not (null (vl-string-search (strcase needle) (strcase hay))))
      (dsh:find-str (strcase hay) (strcase needle)))))

(defun dsh:find-str (hay needle / i n)
  (setq i 1 n (strlen needle))
  (while (and (<= (+ i n -1) (strlen hay)) (/= (substr hay i n) needle))
    (setq i (1+ i)))
  (<= (+ i n -1) (strlen hay)))

(defun dsh:now (/ err)
  (if (not dsh:has-vl)
    0
    (progn
      (setq err (vl-catch-all-apply 'getvar (list "MILLISECS")))
      (if (vl-catch-all-error-p err) 0 err))))

(defun dsh:emit (f v)
  (cond
    ((null v) (princ "nil" f))
    ((= (type v) 'STR) (dsh:emit-str f v))
    ((or (= (type v) 'INT) (= (type v) 'REAL)) (dsh:emit-num f v))
    ((listp v) (dsh:emit-list f v))
    (t (princ "nil" f))))

(defun dsh:emit-list (f lst)
  (princ "(" f)
  (while lst
    (dsh:emit f (car lst))
    (setq lst (cdr lst))
    (if lst (princ " " f)))
  (princ ")" f))

(defun dsh:emit-num (f n / s i c)
  (if (= (type n) 'INT)
    (princ (itoa n) f)
    (progn
      (setq s (rtos n 2 8))
      (setq i 1)
      (while (<= i (strlen s))
        (setq c (substr s i 1))
        (if (= c ",") (princ "." f) (princ c f))
        (setq i (1+ i))))))

(defun dsh:emit-str (f s / i n c code)
  (princ "\"" f)
  (setq i 1 n (strlen s))
  (while (<= i n)
    (setq c (substr s i 1))
    (setq code (ascii c))
    (cond
      ((= c "\\") (princ "\\\\" f))
      ((= c "\"") (princ "\\\"" f))
      ((= code 10) (princ "\\n" f))
      ((= code 13) (princ "\\r" f))
      ((= code 9) (princ "\\t" f))
      ((or (< code 32) (> code 126))
        (princ (strcat "\\U+" (dsh:hex4 code)) f))
      (t (princ c f)))
    (setq i (1+ i)))
  (princ "\"" f))

(defun dsh:hex4 (n / hex digits)
  (setq hex "0123456789ABCDEF" digits "")
  (repeat 4
    (setq digits (strcat (substr hex (1+ (rem n 16)) 1) digits))
    (setq n (/ n 16)))
  digits)

(dsh:start)
