# Makefile for minimp3 WASM decoder

EMSDK_DOCKER_IMAGE ?= emscripten/emsdk:latest
EMCC ?= docker run --rm -u $$(id -u):$$(id -g) -v $(CURDIR):/src -w /src $(EMSDK_DOCKER_IMAGE) emcc
OUTPUT = mp2_decoder

# -o .wasm produces standalone WASM with no JS glue.
# Export the C ABI explicitly so release optimizations do not rename or strip it.
EMFLAGS = -O3 -flto -DNDEBUG \
	-msimd128 \
	-s EXPORTED_FUNCTIONS='["_malloc", "_free", "_mpeg_audio_decoder_create", "_mpeg_audio_decoder_destroy", "_mpeg_audio_decode_payload", "_mpeg_audio_max_samples_per_frame", "_mpeg_audio_decoder_reset", "_wsola_create", "_wsola_destroy", "_wsola_reset", "_wsola_set_ratio", "_wsola_position", "_wsola_has_tail", "_wsola_process", "_software_audio_processor_create", "_software_audio_processor_destroy", "_software_audio_processor_reset", "_software_audio_processor_set_ratio", "_software_audio_processor_process"]' \
	-s EXPORTED_RUNTIME_METHODS='[]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=4194304 \
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
