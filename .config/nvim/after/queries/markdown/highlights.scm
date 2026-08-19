;; extends

;; Neutralize setext headings (a paragraph "underlined" with === or ---).
;;
;; The bundled markdown query captures these as @markup.heading.1/2, so a bullet
;; typed on a new line (`text` + `-`) momentarily colors the paragraph above as
;; a heading. We only use ATX headings (#, ##, ...), so setext parsing is pure
;; downside here.
;;
;; NOTE: capturing as @none does NOT work — neovim's highlighter simply emits no
;; extmark for @none, so the underlying @markup.heading.* extmark still wins.
;; Instead we capture setext heading text/underline as a real highlight group
;; (@markup.setext.neutralized, linked to Normal in markdown.lua) at a higher
;; priority so it overrides the heading color.
(setext_heading
  (paragraph) @markup.setext.neutralized (#set! priority 200)
  (setext_h1_underline) @markup.setext.neutralized (#set! priority 200))

(setext_heading
  (paragraph) @markup.setext.neutralized (#set! priority 200)
  (setext_h2_underline) @markup.setext.neutralized (#set! priority 200))
