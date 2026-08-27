GWCFC ALERT PRODUCT TEMPLATES
========================================

WHAT'S HERE
  _UNIVERSAL_TEMPLATE.txt   Blank format, all fields generic
  _OFFICE_ROSTER.txt        8 field offices + codes
  _INDEX.txt                Numbered list of every product
  products/<hazard>/        One filled-header template per product

STRUCTURE OF EVERY PRODUCT
  Header      Product type, event ID, advisory number, center,
              issuing office, timestamp, disclaimer
  Tier lines  Severity tier + standing call-to-action for that tier
  DISCUSSION & OUTLOOK
  DATA        Hazard-specific fields; any field takes N/A
  HAZARDS     Six standing rows, always present, always answered
  FORECASTER'S NOTES
  $$ / &&     Signature block

CONVENTIONS
  LOCATION    Either signed decimal (7.28, -140.27)
              or hemisphere letters (7.28 N, 140.27 W). Never both.
  N/A         Every DATA field is fillable or N/A. Do not delete rows.
  Offices     Center line first, then one or more 'Issued by' lines.

COUNT
  18 hazards x 3 tiers (Watch/Warning/Emergency)
  x 3 prefixes (Base/Severe/Extreme) = 162 products.
