# Tether Runtime

The Tether runtime establishes an independent state directory, port, browser
adapter and optional model-provider configuration. It deliberately refuses
reserved legacy browser-bridge state directories and ports, so an eventual
Tether install cannot adopt or overwrite another local installation.

It currently recognises only the `chromium` browser adapter. The adapter is not
implemented in this package yet; this module only establishes the safe runtime
contract it must satisfy.
