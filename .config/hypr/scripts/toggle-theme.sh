
#!/bin/bash

# Get current color-scheme setting
current_scheme=$(gsettings get org.gnome.desktop.interface color-scheme)

# Toggle the color-scheme
if [ "$current_scheme" == "'prefer-dark'" ]; then
  gsettings set org.gnome.desktop.interface color-scheme "prefer-light"
else
  gsettings set org.gnome.desktop.interface color-scheme "prefer-dark"
fi
