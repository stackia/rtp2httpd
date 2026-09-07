# Makefile for minimp3 WASM decoder

EMCC = emcc
OUTPUT = mp2_decoder

# Standalone WASM has no JS glue and retains the public KEEPALIVE exports.
EMFLAGS = -O3 \
	-s EXPORTED_FUNCTIONS='["_malloc", "_free"]' \
	-s EXPORTED_RUNTIME_METHODS='[]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=1048576 \
	-s STACK_SIZE=65536 \
	--no-entry

SOURCES = mp2_decoder.c wsola.c

.PHONY: all clean

all: $(OUTPUT).wasm

$(OUTPUT).wasm: $(SOURCES) minimp3.h
	$(EMCC) $(EMFLAGS) $(SOURCES) -o $(OUTPUT).wasm
	@echo "Built $(OUTPUT).wasm ($$(wc -c < $(OUTPUT).wasm) bytes)"

clean:
	rm -f $(OUTPUT).wasm
