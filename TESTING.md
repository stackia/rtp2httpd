# Unit Testing Guide

This project is configured with support for unit testing using the Check framework.

## Prerequisites

Make sure the Check framework is installed on your system:

### Ubuntu/Debian
```bash
sudo apt-get install check libcheck-dev pkg-config
```

### CentOS/RHEL/Fedora
```bash
# CentOS/RHEL
sudo yum install check-devel pkgconfig
# or Fedora
sudo dnf install check-devel pkgconfig
```

## Building and Running Tests

1. **Configure the project** (if Check framework is available):
```bash
./configure
```

2. **Build and run tests**:
```bash
make check
```

This command will:
- Compile the test programs
- Run all tests
- Display test results

## Adding New Tests

### Adding Tests to Existing Modules

Add new test functions in `tests/check_http.c`:

```c
START_TEST(test_your_new_function)
{
    // Test code
    ck_assert_msg(condition, "error message");
}
END_TEST
```

Then add to the appropriate test suite:

```c
tcase_add_test(tc_headers, test_your_new_function);
```

### Creating Tests for New Modules

1. Create a new test file in the `tests/` directory, e.g., `check_rtp.c`
2. Add to `tests/Makefile.am`:

```makefile
TESTS += check_rtp
check_PROGRAMS += check_rtp

check_rtp_SOURCES = check_rtp.c $(top_srcdir)/src/rtp.c
check_rtp_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src
check_rtp_LDADD = @CHECK_LIBS@
```

3. Re-run `autoreconf -fiv` and `./configure`

## Notes

- If the Check framework is unavailable, the configure script will skip test support
- Test programs are located in the `tests/` directory
- Test output files are generated during the build process and can be safely deleted

## Troubleshooting

If you encounter compilation errors:
1. Ensure the Check framework development packages are properly installed
2. Verify that pkg-config can find the check library: `pkg-config --cflags --libs check`
3. Check that the include paths in test files are correct
4. If using a cross-compilation environment, ensure the target platform also has the Check framework
